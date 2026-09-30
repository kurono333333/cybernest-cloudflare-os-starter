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
const articleCalls = new Map();
const articleRecords = new Map();
const articleLog = managerId => {
  let log = articleCalls.get(managerId);
  if (!log) {
    log = { saves: [], reads: [] };
    articleCalls.set(managerId, log);
  }
  return log;
};
export class Probe extends WorkerEntrypoint {
  async readArticleCalls(managerId) {
    return structuredClone(articleLog(managerId));
  }
}
`;

const articleMethods = `
  async saveArticle(input) {
    const managerId = this.ctx.props.managerId;
    articleLog(managerId).saves.push(structuredClone(input));
    let command;
    try { command = JSON.parse(input.commandJson); }
    catch { return {_tag:'integrity_failure'}; }
    if (command.protocolVersion !== 'activity-article/1' ||
        typeof command.operationId !== 'string' || typeof command.actionRef !== 'string') {
      return {_tag:'integrity_failure'};
    }
    const operationKey = managerId + '/' + command.operationId;
    const existing = articleRecords.get(operationKey);
    if (existing) {
      if (existing.payloadHash !== input.payloadHash) return {_tag:'operation_conflict'};
      return {_tag:'already_committed',receipt:structuredClone(existing.receipt)};
    }
    const record = {
      managerId,
      operationId: command.operationId,
      actionRef: command.actionRef,
      payloadHash: input.payloadHash,
      articleId: crypto.randomUUID(),
      revisionId: crypto.randomUUID(),
      receiptId: crypto.randomUUID(),
      committedAt: '2026-09-27T00:00:00.000Z',
      article: command.article,
      body: command.article.sections.map(section => section.text).join(''),
    };
    record.receipt = {
      receiptId: record.receiptId,
      knowledgeId: managerId,
      generation: 1,
      operationId: record.operationId,
      actionRef: record.actionRef,
      payloadHash: record.payloadHash,
      articleId: record.articleId,
      revisionId: record.revisionId,
      revisionNumber: 1,
      committedAt: record.committedAt,
    };
    articleRecords.set(operationKey, record);
    return {_tag:'committed',receipt:structuredClone(record.receipt)};
  }
  async readArticle(input) {
    const managerId = this.ctx.props.managerId;
    articleLog(managerId).reads.push(structuredClone(input));
    const saved = [...articleRecords.values()].find(value =>
      value.managerId === managerId &&
      value.articleId === input.articleId &&
      value.revisionId === input.revisionId);
    if (!saved) return {_tag:'not_found'};
    return {
      _tag:'found',
      knowledgeId: managerId,
      generation: 1,
      articleId: saved.articleId,
      revisionId: saved.revisionId,
      revisionNumber: 1,
      committedAt: saved.committedAt,
      operationId: saved.operationId,
      actionRef: saved.actionRef,
      payloadHash: saved.payloadHash,
      article: saved.article,
      body: saved.body,
    };
  }
`;

const coreFixture = (withArticleMethods) => `
import { WorkerEntrypoint } from 'cloudflare:workers';
${articleState}
export class Access extends WorkerEntrypoint {
  async assertBoundTo(id) { if (id !== this.ctx.props.managerId) throw Error('wrong manager'); }
  async list() {
    return {_tag:'page',items:[{knowledgeId:this.ctx.props.managerId,generation:1,
      displayName:this.ctx.props.managerId,role:'initial',state:'ready',
      createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'}]};
  }
  ${withArticleMethods ? articleMethods : ""}
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

const legacyCore = coreFixture(false);
const upgradedCore = coreFixture(true);

const consumer = `
import { DurableObject, RpcTarget, RpcStub } from 'cloudflare:workers';
const ARTICLE = ${JSON.stringify(article)};
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
    if(mode==='/restart') this.ctx.facets.abort('knowledge',new Error('test restart'));
    const cls=await account.getSingletonGatekeeperClass();
    const facet=this.ctx.facets.get('knowledge',()=>({class:cls,id:'knowledge'}));
    await facet.describe();
    const queue=new Queue();
    using stub=new RpcStub(queue);
    using session=await facet.startSession(stub);
    if(mode==='/article') {
      const proposal=await session.proposeArticle({article:ARTICLE});
      const submission=queue.submissions.at(-1);
      if(!submission) throw Error('article proposal did not submit an approval action');
      await facet.applyAction(submission.action);
      return {rebound,proposal,calls:await this.env.CORE_PROBE.readArticleCalls(managerId)};
    }
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

test("persisted Core capability receives new article methods after Worker update without rebind or Manager crossover", async () => {
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
    assert.deepEqual(await call('/restart'), expected(managerA));
    assert.deepEqual(await call('/restart', managerB), expected(managerB));
  } finally {
    await mf.dispose();
  }
});
