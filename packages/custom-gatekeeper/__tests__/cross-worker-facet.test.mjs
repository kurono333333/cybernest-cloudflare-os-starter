// Run after `pnpm exec capnweb-validate build --out .wrangler/validate`.
// Unlike same-worker Vitest fixtures, this crosses the deployed facet-class boundary.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(root + "package.json");
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const { build } = wranglerRequire("esbuild");
const { parse } = wranglerRequire("jsonc-parser");
const config = parse(await readFile(root + "wrangler.jsonc", "utf8"));
const managerA = "44444444-4444-4444-8444-444444444444";
const managerB = "54444444-4444-4444-8444-444444444444";
const sourceId = "74444444-4444-4444-8444-444444444444";
const revisionId = "84444444-4444-4444-8444-444444444444";

const custom = await build({
  stdin: { contents: `
    export * from './.wrangler/validate/src/index.ts';
    import { WorkerEntrypoint as FixtureEntrypoint } from 'cloudflare:workers';
    export class LegacyFactory extends FixtureEntrypoint {
      create(access) { return this.ctx.exports.CustomAccount({props:{access}}); }
    }
  `, resolveDir: root, loader: "ts" },
  bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
  conditions: ["workerd", "worker", "browser"], external: ["cloudflare:*", "node:*"],
});

const core = `
import { WorkerEntrypoint } from 'cloudflare:workers';
export class Access extends WorkerEntrypoint {
  async assertBoundTo(id) { if (id !== this.ctx.props.managerId) throw Error('wrong manager'); }
  async list() {
    return {_tag:'page',items:[{knowledgeId:this.ctx.props.managerId,generation:1,
      displayName:this.ctx.props.managerId,role:'initial',state:'ready',
      createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'}]};
  }
  async readBronze(input) {
    if(input.knowledgeId !== this.ctx.props.managerId) throw Error('wrong knowledge');
    const document='# '+this.ctx.props.managerId;
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(document));
    return {_tag:'found',revision:{knowledgeId:input.knowledgeId,generation:1,
      sourceId:input.sourceId,revisionId:'${revisionId}',revisionNumber:1,baseRevisionId:null,
      document,contentHash:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join(''),
      type:'Source',title:'Fixture',description:'Local cross-worker fixture',
      provenance:{sourceKind:'explicit_user_input',reference:'fixture',capturedAt:'2026-01-01T00:00:00.000Z'},
      committedAt:'2026-01-01T00:00:00.000Z'}};
  }
}
export default {async fetch(request,env,ctx) {
  const url=new URL(request.url);
  const managerId=url.searchParams.get('manager');
  const access=ctx.exports.Access({props:{managerId}});
  try {return Response.json(await env.CONSUMER.getByName(managerId).run(managerId,access,url.pathname));}
  catch(error) {return Response.json({error:error.message},{status:500});}
}};
`;

const consumer = `
import { DurableObject, RpcTarget, RpcStub } from 'cloudflare:workers';
class Queue extends RpcTarget {
  observations=[];
  async authorizeObservation(value) { this.observations.push(value); }
}
export class Consumer extends DurableObject {
  async run(managerId,access,mode) {
    if(mode==='/legacy') {
      const legacy=await this.env.LEGACY.create(access);
      try { await legacy.inspectManagerBinding('${managerB}'); }
      catch(error) {
        if(error.message!=='wrong manager') throw error;
        await this.ctx.storage.put('legacyMismatchRejected',true);
      }
      await this.ctx.storage.put('account',legacy);
      return {binding:await legacy.inspectManagerBinding(managerId),
        mismatchRejected:await this.ctx.storage.get('legacyMismatchRejected')};
    }
    let account=await this.ctx.storage.get('account');
    if(!account || await account.inspectManagerBinding(managerId)==='legacy') {
      account=await this.env.VENDOR.createManagerAccount(managerId,access);
      await this.ctx.storage.put('account',account);
    }
    if(mode==='/wrong-manager') {
      try { await this.env.VENDOR.createManagerAccount('${managerB}',access); }
      catch(error) {return {rejected:error.message};}
      throw Error('wrong manager was accepted');
    }
    if(mode==='/restart') this.ctx.facets.abort('knowledge',new Error('test restart'));
    const cls=await account.getSingletonGatekeeperClass();
    const facet=this.ctx.facets.get('knowledge',()=>({class:cls,id:'knowledge'}));
    await facet.describe();
    const queue=new Queue();
    using stub=new RpcStub(queue);
    using session=await facet.startSession(stub);
    const page=await session.list({limit:1});
    const item=page.items[0];
    using handle=item.access;
    const revision=await handle.readBronze({sourceId:'${sourceId}'});
    return {knowledgeId:item.knowledgeId,document:revision.document,
      privateObservations:queue.observations.map(o=>o.prohibitAllSharing)};
  }
}
export default {fetch(){return new Response('fixture');}};
`;

test("cross-worker persisted account, native facet, list/read, restart and Manager isolation", async () => {
  const common = {
    modules: true, compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    // There are no remote bindings. Unexpected outbound network is forbidden.
    outboundService: () => new Response("Network forbidden in fixture", { status: 503 }),
  };
  const options = convertV4MiniflareOptions({ workers: [
    { ...common, name: "core", script: core, durableObjects: {
      CONSUMER: { className: "Consumer", scriptName: "consumer", useSQLite: true },
    } },
    { ...common, name: "custom", script: custom.outputFiles[0].text,
      durableObjects: Object.fromEntries(config.migrations.flatMap(m=>m.new_sqlite_classes ?? [])
        .map(className=>[className,{className,useSQLite:true}])) },
    { ...common, name: "consumer", script: consumer,
      durableObjects: { CONSUMER: { className: "Consumer", useSQLite: true } },
      serviceBindings: {
        VENDOR: { name: "custom", entrypoint: "GatekeeperVendor" },
        LEGACY: { name: "custom", entrypoint: "LegacyFactory" },
      } },
  ] });
  const mf = new Miniflare(options);
  const call = async (path, managerId = managerA) => {
    const response = await mf.dispatchFetch('http://fixture' + path + '?manager=' + managerId);
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  const expected = id => ({knowledgeId:id,document:'# '+id,privateObservations:[true,true]});
  try {
    assert.deepEqual(await call('/'), expected(managerA));
    assert.deepEqual(await call('/restart'), expected(managerA));
    assert.deepEqual(await call('/', managerB), expected(managerB));
    assert.deepEqual(await call('/wrong-manager'), {rejected:'wrong manager'});
    assert.deepEqual(await call('/restart', managerB), expected(managerB));
    assert.deepEqual(await call('/legacy'), {binding:'legacy',mismatchRejected:true});
    assert.deepEqual(await call('/restart'), expected(managerA));
    await mf.setOptions(options);
    assert.deepEqual(await call('/restart'), expected(managerA));
    assert.deepEqual(await call('/restart', managerB), expected(managerB));
  } finally {
    await mf.dispose();
  }
});
