const {test}=require('node:test');
const assert=require('node:assert/strict');
const {providerClients,research,AtlasError}=require('../atlas/research');
const {conversationContext,DEFAULTS}=require('../atlas/model-router');
const signal=()=>new AbortController().signal;
const ok=data=>({ok:true,json:async()=>data});
const store=()=>({reservations:[],async reserve(...args){this.reservations.push(args);}});
const messages=[{role:'user',content:'Explain the tradeoffs.'}];

test('Groq selects genuinely different quick/detailed models, effort, and output budgets',async()=>{
 const requests=[],quota=store();
 const clients=providerClients({env:{ATLAS_FREE_PROVIDERS_CONFIRMED:'true',ATLAS_GROQ_API_KEY:'fixture'},store:quota,request:async(url,o)=>{requests.push(JSON.parse(o.body));return ok({choices:[{message:{content:'Answer'},finish_reason:'stop'}],usage:{total_tokens:10}});}});
 const q=await clients.complete(messages,false,signal(),{depth:'quick'});
 const d=await clients.complete(messages,false,signal(),{depth:'detailed'});
 assert.equal(q.model,'openai/gpt-oss-20b');assert.equal(d.model,'openai/gpt-oss-120b');
 assert.equal(requests[0].reasoning_effort,'low');assert.equal(requests[1].reasoning_effort,'high');
 assert.ok(requests[1].max_completion_tokens>requests[0].max_completion_tokens);
 assert.equal(quota.reservations.length,8);assert.equal(requests.some(r=>r.models||r.tools),false);
});

test('local Qwen modes change model, thinking, context, and output without cloud access',async()=>{
 const requests=[];const clients=providerClients({env:{ATLAS_LLM_PROVIDER:'ollama'},store:{},request:async(url,o)=>{
 assert.ok(url.startsWith('http://127.0.0.1:11434/'));
 if(url.endsWith('/tags'))return ok({models:Object.values(DEFAULTS.ollama).map(name=>({name}))});
 const body=JSON.parse(o.body);requests.push(body);return ok({message:{content:'Final only',thinking:'Private reasoning'},eval_count:20});}});
 assert.equal((await clients.complete(messages,false,signal(),{depth:'quick'})).content,'Final only');
 await clients.complete(messages,false,signal(),{depth:'detailed'});
 assert.equal(requests[0].model,'qwen3.5:4b');assert.equal(requests[1].model,'qwen3.5:9b');
 assert.equal(requests[0].think,false);assert.equal(requests[1].think,true);
 assert.ok(requests[1].options.num_ctx>requests[0].options.num_ctx);
 assert.ok(requests[1].options.num_predict>requests[0].options.num_predict);
});

function openRouter(pricing={prompt:'0',completion:'0',request:'0'},overrides={}){
 const sent=[];const client=providerClients({env:{ATLAS_LLM_PROVIDER:'openrouter',ATLAS_OPENROUTER_API_KEY:'fixture',ATLAS_FREE_PROVIDERS_CONFIRMED:'true',...overrides},store:store(),request:async(url,o)=>{
 if(url.endsWith('/models'))return ok({data:[{id:DEFAULTS.openrouter.quick,pricing,supported_parameters:['response_format','reasoning']}]});
 sent.push(JSON.parse(o.body));return ok({choices:[{message:{content:'{"findings":[]}'},finish_reason:'stop'}]});}});return{client,sent};
}

test('OpenRouter verifies zero catalogue prices and sends a zero-price ceiling with no fallbacks',async()=>{
 const {client,sent}=openRouter();await client.complete(messages,true,signal());
 assert.ok(sent[0].model.endsWith(':free'));assert.deepEqual(sent[0].provider,{allow_fallbacks:false,max_price:{prompt:0,completion:0}});
 assert.equal(sent[0].models,undefined);assert.equal(sent[0].reasoning.exclude,true);
});

test('paid, missing, malformed, or nonzero model pricing fails closed before inference',async()=>{
 for(const pricing of [{prompt:'0.01',completion:'0'},{prompt:'0',completion:'0',request:'1'},{prompt:null,completion:'0'},{prompt:'',completion:'0'},{completion:'0'}]){
 const {client,sent}=openRouter(pricing);await assert.rejects(client.complete(messages,false,signal()),{status:503});assert.equal(sent.length,0);}
 const {client,sent}=openRouter(undefined,{ATLAS_OPENROUTER_QUICK_MODEL:'some/paid-model'});
 await assert.rejects(client.complete(messages,false,signal()),{status:503});assert.equal(sent.length,0);
});

test('rate limits do not route to another provider or make an automatic retry',async()=>{
 let calls=0;const client=providerClients({env:{ATLAS_FREE_PROVIDERS_CONFIRMED:'true',ATLAS_GROQ_API_KEY:'fixture'},store:store(),request:async()=>{calls++;return{ok:false,status:429,headers:{get:()=> '30'}};}});
 await assert.rejects(client.complete(messages,false,signal()),{status:429});await assert.rejects(client.complete(messages,false,signal()),{status:429});assert.equal(calls,1);
});

test('Detailed waits once for a local minute reservation before sending a provider request', async () => {
    let requests = 0, tokenAttempts = 0;
    const stages = [], reservations = [];
    const clients = providerClients({
        env: { ATLAS_FREE_PROVIDERS_CONFIRMED: 'true', ATLAS_GROQ_API_KEY: 'fixture' },
        store: { async reserve(name, window) {
            reservations.push(name);
            if (window === 'minute' && name.endsWith('-tokens') && ++tokenAttempts === 1) {
                throw new AtlasError(429, 'Minute limit', 0.001);
            }
        } },
        request: async () => {
            requests++;
            return ok({ choices: [{ message: { content: 'Reviewed answer' } }] });
        }
    });
    await clients.complete(messages, true, signal(), { depth: 'detailed', purpose: 'review', onWait: value => {
        assert.equal(requests, 0);
        stages.push(value);
    } });
    assert.equal(requests, 1);
    assert.equal(stages.length, 1);
    assert.ok(reservations.every(name => name.startsWith('groq-openai/gpt-oss-120b-')));
});

test('cancelling a free-quota wait prevents the provider request', async () => {
    const controller = new AbortController();
    let requests = 0;
    const clients = providerClients({
        env: { ATLAS_FREE_PROVIDERS_CONFIRMED: 'true', ATLAS_GROQ_API_KEY: 'fixture' },
        store: { async reserve() { throw new AtlasError(429, 'Minute limit', 30); } },
        request: async () => { requests++; throw new Error('Unexpected inference'); }
    });
    await assert.rejects(clients.complete(messages, true, controller.signal, {
        depth: 'detailed', onWait: () => controller.abort()
    }), { name: 'AbortError' });
    assert.equal(requests, 0);
});

test('long Groq chats trim older context and preserve the current question', async () => {
    let body;
    const clients = providerClients({
        env: { ATLAS_FREE_PROVIDERS_CONFIRMED: 'true', ATLAS_GROQ_API_KEY: 'fixture' }, store: store(),
        request: async (url, options) => {
            body = JSON.parse(options.body);
            return ok({ choices: [{ message: { content: 'Current answer' } }] });
        }
    });
    const history = [{ role: 'system', content: 'Trusted instructions' }, ...Array.from({ length: 20 }, () => ({
        role: 'assistant', content: 'Earlier discussion. '.repeat(100)
    })), { role: 'user', content: 'Current question' }];
    await clients.complete(history, false, signal(), { depth: 'detailed' });
    assert.ok(body.messages.length < history.length);
    assert.equal(body.messages[0].content, 'Trusted instructions');
    assert.equal(body.messages.at(-1).content, 'Current question');
    assert.ok(body.max_completion_tokens >= 1400);
});

const sourceText='The tested battery lasts 14 hours under the documented test conditions.';
const candidate=()=>JSON.stringify({findings:[{text:'14 hours',source:1,passage:1,quote:sourceText}],listings:[],assessments:[]});
function workflows({failReview=false,repair=false}={}){
 let seq=0;const record={searches:[],calls:[]};return {record,clients:{async search(query,cap){record.searches.push({query,cap});return Array.from({length:cap},()=>({url:'https://evidence.example.org/source-'+(++seq),title:'Battery test '+seq,raw_content:sourceText}));},
 async complete(prompt,structured,sig,options){record.calls.push({prompt,structured,...options});if(options.purpose==='plan')return{content:JSON.stringify({queries:['battery test','manufacturer battery methodology','independent battery limitations']}),tokens:10};
 if(options.purpose==='review'&&failReview)throw new AtlasError(429,'Free quota');
 if(options.purpose==='answer'&&repair)return{content:'not JSON',tokens:5};return{content:candidate(),tokens:10,provider:'fixture',model:options.depth};}}};
}
const run=(depth,clients,kind='research',prior)=>research({input:{text:prior?'Compare those results':'Research the current battery test',depth,filters:{}},kind,prior,context:[],clients,stage(){},partial(){},signal:signal()});

test('Quick research is focused; Detailed plans three angles and performs a separate evidence review',async()=>{
 const q=workflows(),d=workflows();const qr=await run('quick',q.clients),dr=await run('detailed',d.clients);
 assert.equal(q.record.searches.length,1);assert.equal(qr.usage.pages,5);assert.equal(q.record.calls.length,1);
 assert.equal(d.record.searches.length,3);assert.equal(dr.usage.pages,8);assert.deepEqual(d.record.calls.map(c=>c.purpose),['plan','answer','review']);
 assert.equal(dr.verification.status,'reviewed');assert.equal(dr.verification.passes,2);assert.equal(dr.usage.calls,3);
 assert.equal(qr.depth,'quick');assert.equal(dr.depth,'detailed');assert.equal(dr.findings[0].text,'14 hours');
});

test('eight long research pages fit Groq prompts while retaining full saved passages', async () => {
    const bodies = [], quota = store();
    let page = 0;
    const passage = (sourceText + ' ' + 'Documented battery methodology and limitations. '.repeat(18)).slice(0, 760);
    const clients = providerClients({
        env: { ATLAS_FREE_PROVIDERS_CONFIRMED: 'true', ATLAS_GROQ_API_KEY: 'fixture', ATLAS_TAVILY_API_KEY: 'fixture' },
        store: quota,
        request: async (url, options) => {
            const body = JSON.parse(options.body);
            if (url.includes('tavily')) return ok({ results: Array.from({ length: body.max_results }, () => ({
                url: 'https://evidence.example.org/' + (++page), title: 'A documented battery test', raw_content: passage + '\n\n' + passage
            })) });
            bodies.push(body);
            return ok({ choices: [{ message: { content: body.model.endsWith('20b') ? JSON.stringify({ queries: ['battery test', 'battery methodology', 'battery limitations'] }) : candidate() } }] });
        }
    });
    const report = await run('detailed', clients);
    assert.equal(report.verification.status, 'reviewed');
    assert.equal(report.sources.length, 8);
    assert.equal(bodies.length, 3);
    for (const body of bodies.slice(1)) {
        assert.ok(Buffer.byteLength(JSON.stringify(body.messages)) <= 10_000);
        assert.ok(body.max_completion_tokens >= 2000);
    }
    assert.equal(report.sources[0].passages[0].text.length, 760);
    assert.ok(quota.reservations.filter(([name, window]) => name.endsWith('-tokens') && window === 'minute').every(([, , amount]) => amount <= 7500));
});

test('a review quota failure retains validated findings and marks the review incomplete',async()=>{
 const {clients}=workflows({failReview:true});const report=await run('detailed',clients);
 assert.equal(report.verification.status,'partial');assert.equal(report.usage.calls,3);assert.equal(report.findings[0].text,'14 hours');
});

test('repair and review share one call budget; repairs cannot create a fourth model call',async()=>{
 const {clients,record}=workflows({repair:true});const report=await run('detailed',clients);
 assert.deepEqual(record.calls.map(c=>c.purpose),['plan','answer','repair']);assert.equal(report.verification.status,'partial');assert.equal(report.usage.calls,3);
});

test('both chat modes use one model call and no search, with different instructions',async()=>{
 const q=workflows(),d=workflows();await run('quick',q.clients,'chat');await run('detailed',d.clients,'chat');
 assert.equal(q.record.searches.length+d.record.searches.length,0);assert.equal(q.record.calls.length,1);assert.equal(d.record.calls.length,1);
 assert.match(q.record.calls[0].prompt[0].content,/concisely/);assert.match(d.record.calls[0].prompt[0].content,/edge cases/);
});

test('Detailed follow-ups reuse existing evidence and add review without another web search',async()=>{
 const f=workflows();const report=await run('detailed',f.clients,'research',{kind:'research',sources:[{title:'Saved battery test',url:'https://evidence.example.org/saved',passages:[{text:sourceText}]}]});
 assert.equal(f.record.searches.length,0);assert.deepEqual(f.record.calls.map(c=>c.purpose),['answer','review']);assert.equal(report.verification.status,'reviewed');
});

test('conversation context retains code formatting and structured results with bounded, deeper history',()=>{
 const history=Array.from({length:24},(_,i)=>({role:i%2?'assistant':'user',text:'Message '+i+'\n  indented code'}));
 history[23].report={findings:[],listings:[{fields:{salary:{text:'EUR 5000 monthly'}}}]};
 const q=conversationContext(history,'quick'),d=conversationContext(history,'detailed');assert.equal(q.length,8);assert.equal(d.length,20);
 assert.match(d.at(-1).content,/EUR 5000 monthly/);assert.match(d.at(-1).content,/\n  indented code/);
 assert.ok(d.reduce((sum,m)=>sum+m.content.length,0)<=16000);
});
const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const express=require('express');const {createLocalStore}=require('../atlas/local-store');const {createAtlasRouter}=require('../atlas/router');

test('HTTP mode choice reaches the server router, ignores browser model overrides, and restores provenance without model calls',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'atlas-mode-http-'));t.after(async()=>{await fs.unlink(path.join(dir,'store.json'));await fs.rmdir(dir);});
 const records=[];const clients={ready(){},describe:()=>({provider:'fixture',configured:true,quick:'small-free',detailed:'large-free'}),async complete(messages,structured,signal,options){records.push(options);return{content:'Actual route: '+options.depth,tokens:12,provider:'fixture',model:options.depth==='detailed'?'large-free':'small-free'};}};
 const app=express();app.use(express.json());app.use('/api/atlas',createAtlasRouter({store:createLocalStore(path.join(dir,'store.json')),clients,env:{SESSION_SECRET:'mode-fixture'}}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port+'/api/atlas';let cookie='';async function api(url,body){const r=await fetch(base+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Cookie:cookie},...(body?{body:JSON.stringify(body)}:{})});for(const c of r.headers.getSetCookie()){if(c.startsWith('atlas_session='))cookie=c.split(';')[0];}return{status:r.status,data:await r.json()};}
 assert.equal((await api('/capabilities')).data.models.detailed,'large-free');
 for(const depth of ['quick','detailed']){const chat=(await api('/conversations',{})).data;const result=await api('/conversations/'+chat.id+'/messages',{text:'Explain a closure',depth,model:'paid/browser-override',clientId:require('node:crypto').randomUUID()});assert.equal(result.status,202);
 for(let n=0;n<40;n++){const run=await api('/runs/'+result.data.run);if(run.data.state!=='running')break;await new Promise(r=>setTimeout(r,10));}
 const saved=(await api('/conversations/'+chat.id)).data.messages.at(-1).report;assert.equal(saved.depth,depth);assert.equal(saved.usage.models[0].model,depth==='quick'?'small-free':'large-free');const before=records.length;await api('/conversations/'+chat.id);assert.equal(records.length,before);assert.equal(records.at(-1).model,undefined);}
 assert.equal(records.length,2);
});
