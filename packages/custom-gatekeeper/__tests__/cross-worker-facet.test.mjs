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
const article = { sections: [{ text: "Cross-worker article.\n", meaning: "observed_result", sourceIds: ["fixture-source"] }], sources: [{ sourceId: "fixture-source", kind: "conversation", reference: "fixture/chat", actor: { kind: "user", reference: "fixture/user" }, recordedAt: "2026-09-27T00:00:00.000Z", excerpt: "Persist this only after explicit approval." }] };

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

const articleState = `
const knowledgeReaderCalls = new Map();
const knowledgeReaderLog = managerId => {
  let log = knowledgeReaderCalls.get(managerId);
  if (!log) {
    log = { list: [], search: [], read: [], readExpirySnapshots: [] };
    knowledgeReaderCalls.set(managerId, log);
  }
  return log;
};
export class Probe extends WorkerEntrypoint {
  async readKnowledgeCalls(managerId) {
    return structuredClone(knowledgeReaderLog(managerId));
  }
}
`;

const knowledgeReaderMethods = label => `
  async list(input) {
    const managerId = this.ctx.props.managerId;
    knowledgeReaderLog(managerId).list.push(structuredClone(input));
    return {ok:true,value:{value:{bundleId:'${'a'.repeat(64)}',versionId:'94444444-4444-4444-8444-444444444444',items:[{path:'index.md'}]},expiresAt:Date.now()+3600000}};
  }
  async search(input) {
    const managerId = this.ctx.props.managerId;
    knowledgeReaderLog(managerId).search.push(structuredClone(input));
    return {ok:true,value:{value:{bundleId:'${'a'.repeat(64)}',versionId:'94444444-4444-4444-8444-444444444444',hits:[{path:'index.md',line:1,snippet:'Private ${label} fixture.'}]},expiresAt:Date.now()+3600000}};
  }
  async read(input) {
    const managerId = this.ctx.props.managerId;
    const expiresAt = Date.now()+3600000;
    knowledgeReaderLog(managerId).read.push(structuredClone(input));
    knowledgeReaderLog(managerId).readExpirySnapshots.push(expiresAt);
    return {ok:true,value:{value:{bundleId:'${'a'.repeat(64)}',versionId:'94444444-4444-4444-8444-444444444444',path:'index.md',sourceMarkdown:'# Private ${label} fixture\\n',metadata:{type:'Concept'}},expiresAt}};
  }
`;

const coreFixture = (label) => `
import { WorkerEntrypoint } from 'cloudflare:workers';
${articleState}
export class Access extends WorkerEntrypoint {
  async assertBoundTo(id) { if (id !== this.ctx.props.managerId) throw Error('wrong manager'); return 'cybernest-knowledge-read-v1'; }
  ${knowledgeReaderMethods(label)}
}
export default {async fetch(request,env,ctx) {
  const url=new URL(request.url);
  const managerId=url.searchParams.get('manager');
  const access=ctx.exports.Access({props:{managerId}});
  try {return Response.json(await env.CONSUMER.getByName(managerId).run(managerId,access,url.pathname));}
  catch(error) {return Response.json({error:error.message},{status:500});}
}};
`;

const initialCore = coreFixture('initial');
const updatedCore = coreFixture('updated');

const consumer = `
import { DurableObject, RpcTarget, RpcStub } from 'cloudflare:workers';
class Queue extends RpcTarget {
  observations=[];
  submissions=[];
  async authorizeObservation(value) { this.observations.push(value); }
  async submitAction(action,description) {
    this.submissions.push({action,description:structuredClone(description)});
  }
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
    let rebound=false;
    if(!account || await account.inspectManagerBinding(managerId)==='legacy') {
      account=await this.env.VENDOR.createManagerAccount(managerId,access);
      await this.ctx.storage.put('account',account);
      rebound=true;
    }
    if(mode==='/wrong-manager') {
      try { await this.env.VENDOR.createManagerAccount('${managerB}',access); }
      catch(error) {return {rejected:error.message};}
      throw Error('wrong manager was accepted');
    }
    if(mode==='/restart' || mode==='/reader-restart') this.ctx.facets.abort('knowledge',new Error('test restart'));
    const cls=await account.getSingletonGatekeeperClass();
    const facet=this.ctx.facets.get('knowledge',()=>({class:cls,id:'knowledge'}));
    await facet.describe();
    const queue=new Queue();
    using stub=new RpcStub(queue);
    using session=await facet.startSession(stub);
    if(mode==='/' || mode==='/restart' || mode==='/reader' || mode==='/reader-restart') {
      const result={list:undefined,search:undefined,read:undefined,
        errors:{list:null,search:null,read:null}};
      try {result.list=await session.list({offset:0,limit:16});}
      catch(error) {result.errors.list=error.message;}
      try {result.search=await session.search({query:'private',offset:0,limit:16});}
      catch(error) {result.errors.search=error.message;}
      try {result.read=await session.read({path:'index.md'});}
      catch(error) {result.errors.read=error.message;}
      return {rebound,...result,observations:queue.observations,
        calls:await this.env.CORE_PROBE.readKnowledgeCalls(managerId)};
    }
    throw Error('unsupported fixture route');
  }
}
export default {fetch(){return new Response('fixture');}};
`;

test("persisted D04 reader capability stays Manager-scoped across Worker update and restart", async () => {
  const common = {
    modules: true, compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    outboundService: () => new Response("Network forbidden in fixture", { status: 503 }),
  };
  const options = coreScript => convertV4MiniflareOptions({ workers: [
    { ...common, name: "core", script: coreScript, durableObjects: {
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
        CORE_PROBE: { name: "core", entrypoint: "Probe" },
      } },
  ] });
  const mf = new Miniflare(options(initialCore));
  const call = async (path, managerId = managerA) => {
    const response = await mf.dispatchFetch('http://fixture' + path + '?manager=' + managerId);
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  try {
    const beforeUpdate = await call('/reader');
    assert.equal(beforeUpdate.rebound, true, 'the first access binds the Manager once');
    assert.deepEqual(beforeUpdate.errors, { list: null, search: null, read: null });
    assert.equal(beforeUpdate.search.hits[0].snippet, 'Private initial fixture.');
    assert.equal(beforeUpdate.read.sourceMarkdown, '# Private initial fixture\n');
    assert.ok(beforeUpdate.observations.every(o => o.containsRestrictedData && o.ownerInvitesOnly));
    await mf.setOptions(options(updatedCore));

    const first = await call('/reader');
    assert.equal(first.rebound, false, 'reader calls must reuse the persisted account');
    assert.deepEqual(first.errors, { list: null, search: null, read: null });
    assert.deepEqual(first.list, {
      bundleId: 'a'.repeat(64),
      versionId: '94444444-4444-4444-8444-444444444444',
      items: [{ path: 'index.md' }],
    });
    assert.deepEqual(first.search, {
      bundleId: 'a'.repeat(64),
      versionId: '94444444-4444-4444-8444-444444444444',
      hits: [{ path: 'index.md', line: 1, snippet: 'Private updated fixture.' }],
    });
    assert.deepEqual(first.read, {
      bundleId: 'a'.repeat(64),
      versionId: '94444444-4444-4444-8444-444444444444',
      path: 'index.md',
      sourceMarkdown: '# Private updated fixture\n',
      metadata: { type: 'Concept' },
    });
    assert.equal(first.observations.length, 3);
    assert.ok(first.observations.every(o => o.containsRestrictedData && o.ownerInvitesOnly));

    const restarted = await call('/reader-restart');
    assert.equal(restarted.rebound, false, 'restart must preserve the stored reader capability');
    assert.deepEqual(restarted.errors, { list: null, search: null, read: null });
    assert.equal(restarted.calls.list.length, 2);
    assert.equal(restarted.calls.search.length, 2);
    assert.equal(restarted.calls.read.length, 2);
    assert.ok(restarted.calls.readExpirySnapshots.every(expiry => expiry > Date.now()));
    assert.doesNotMatch(JSON.stringify([first.list, first.search, first.read]),
      /expiresAt|receiptId|managerId|userId|ownerId/u);
    const managerBResult = await call('/reader', managerB);
    assert.equal(managerBResult.rebound, true, 'another Manager receives an independent persisted binding');
    assert.equal(managerBResult.search.hits[0].snippet, 'Private updated fixture.');
    assert.ok(managerBResult.observations.every(o => o.containsRestrictedData && o.ownerInvitesOnly));
    assert.deepEqual(await call('/wrong-manager'), { rejected: 'wrong manager' });
  } finally {
    await mf.dispose();
  }
});

test.skip("retired article writer does not define the D04 cross-worker contract", async () => {
  const common = {
    modules: true, compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    // There are no remote bindings. Unexpected outbound network is forbidden.
    outboundService: () => new Response("Network forbidden in fixture", { status: 503 }),
  };
  const makeOptions = (coreScript) => convertV4MiniflareOptions({ workers: [
    { ...common, name: "core", script: coreScript, durableObjects: {
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
        CORE_PROBE: { name: "core", entrypoint: "Probe" },
      } },
  ] });
  const mf = new Miniflare(makeOptions(legacyCore));
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
    await mf.setOptions(makeOptions(upgradedCore));
    const articleResultA = await call('/article', managerA);
    assert.equal(articleResultA.rebound, false, 'article call must reuse the persisted account without rebinding');
    assert.equal(articleResultA.proposal.status, 'pending_approval');
    assert.equal(articleResultA.calls.saves.length, 1, 'stored old Core capability must receive saveArticle after Worker update');
    assert.equal(articleResultA.calls.reads.length, 1, 'stored old Core capability must receive exact readArticle after Worker update');
    const articleCommandA = JSON.parse(articleResultA.calls.saves[0].commandJson);
    assert.deepEqual(articleCommandA.article, article);
    assert.match(articleResultA.calls.saves[0].payloadHash, /^[0-9a-f]{64}$/u);
    assert.equal(articleResultA.calls.reads[0].articleId.length, 36);
    assert.equal(articleResultA.calls.reads[0].revisionId.length, 36);

    const articleResultB = await call('/article', managerB);
    assert.equal(articleResultB.rebound, false, 'Manager B must also reuse its own persisted account');
    assert.equal(articleResultB.calls.saves.length, 1, 'Manager B article must reach Manager B Core props');
    assert.equal(articleResultB.calls.reads.length, 1, 'Manager B exact read must remain isolated');
    assert.equal(JSON.parse(articleResultB.calls.saves[0].commandJson).protocolVersion, 'activity-article/1');
    assert.notEqual(articleResultA.calls.reads[0].articleId, articleResultB.calls.reads[0].articleId);
    assert.notEqual(articleResultA.calls.reads[0].revisionId, articleResultB.calls.reads[0].revisionId);

    const readerResultA = await call('/reader', managerA);
    assert.equal(readerResultA.rebound, false, 'new reader calls must reuse the persisted account');
    assert.deepEqual(readerResultA.errors, {list:null,search:null,read:null});
    assert.equal(readerResultA.list.items[0].path, 'index.md');
    assert.equal(readerResultA.search.hits[0].path, 'index.md');
    assert.equal(readerResultA.read.sourceMarkdown, '# Private Knowledge fixture\n');
    assert.doesNotMatch(JSON.stringify([readerResultA.list,readerResultA.search,readerResultA.read]),
      /expiresAt|receiptId|managerId|userId|ownerId/u);
    assert.deepEqual(readerResultA.calls, {
      list:[{offset:0,limit:16}],
      search:[{query:'private',offset:0,limit:16}],
      read:[{path:'index.md'}],
      readExpirySnapshots:[readerResultA.calls.readExpirySnapshots[0]],
    });
    assert.ok(readerResultA.calls.readExpirySnapshots[0] > Date.now());
    assert.equal(readerResultA.observations.length, 3);
    assert.ok(readerResultA.observations.every(o => o.containsRestrictedData && o.ownerInvitesOnly));

    const restartedReaderResultA = await call('/reader-restart', managerA);
    assert.equal(restartedReaderResultA.rebound, false, 'restart must retain the same stored reader capability');
    assert.deepEqual(restartedReaderResultA.errors, {list:null,search:null,read:null});
    assert.deepEqual(restartedReaderResultA.calls.list, [
      {offset:0,limit:16}, {offset:0,limit:16},
    ]);
    assert.deepEqual(restartedReaderResultA.calls.search, [
      {query:'private',offset:0,limit:16}, {query:'private',offset:0,limit:16},
    ]);
    assert.deepEqual(restartedReaderResultA.calls.read, [
      {path:'index.md'}, {path:'index.md'},
    ]);
    assert.deepEqual(await call('/restart'), expected(managerA));
    assert.deepEqual(await call('/restart', managerB), expected(managerB));
  } finally {
    await mf.dispose();
  }
});
