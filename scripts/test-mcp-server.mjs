// Offline MCP verification: every phone operation is mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import path from 'node:path';
import {createPhoneMcpServer,project,validateAction,actionSchema} from '../src/server.mjs';
const root=path.resolve(import.meta.dirname,'..');

test('server mounts and lists tools even without config, ADB, Python or a connected device',async t=>{
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'src/server.mjs'),'--config',path.join(root,'not-present.config.json')],stderr:'pipe'});
 const client=new Client({name:'offline-check',version:'1'});t.after(async()=>{await client.close();await transport.close();});
 await client.connect(transport);const tools=(await client.listTools()).tools;
 assert.deepEqual(tools.map(t=>t.name).sort(),['phone_action','phone_apps','phone_observe','phone_open_app','phone_status']);
 const result=await client.callTool({name:'phone_status',arguments:{}});assert.equal(result.isError,true);assert.match(result.content[0].text,/npm run config/);
 assert.ok(!result.content[0].text.includes(root));
});

test('strict action contracts reject device selection, shell commands and mixed input forms',()=>{
 for(const args of [{observationId:'one',action:'tap',x:1,y:1},{observationId:'one',action:'text',text:'hi',serial:'other'},
  {observationId:'one',action:'shell',text:'id'}])assert.equal(actionSchema.safeParse(args).success,false);
 for(const args of [{observationId:'one',action:'aim',x:1,y:2},{observationId:'one',action:'tap_aimed',aimId:'aim',x:3},
  {observationId:'one',action:'text',text:'hello',button:'back'}])assert.throws(()=>validateAction(args));
});

test('actual MCP invokes only the fixed local-owner key and keeps image bytes outside metadata',async t=>{
 const calls=[];const image={mimeType:'image/png',data:Buffer.from('fixture image').toString('base64')};
 const service={observe:async args=>{calls.push(args);return {observationId:'one',image,view:{coordinateSpace:'view_normalized_1000'}};},
  act:async args=>{calls.push(args);return {actionIssued:args.action!=='aim',aimId:'aim',image};}};
 const {server,dispose}=createPhoneMcpServer({serviceProvider:()=>service});
 const [one,two]=InMemoryTransport.createLinkedPair();const client=new Client({name:'offline-check',version:'1'});
 t.after(async()=>{await client.close();await server.close();await dispose();});await Promise.all([server.connect(one),client.connect(two)]);
 const result=await client.callTool({name:'phone_observe',arguments:{}});assert.equal(result.content[1].type,'image');
 assert.ok(!result.content[0].text.includes(image.data));assert.equal(calls[0].key,'private:local-owner');
 const aim=await client.callTool({name:'phone_action',arguments:{observationId:'one',action:'aim',x:100,y:200,targetDescription:'目标图标'}});
 assert.equal(JSON.parse(aim.content[0].text).actionIssued,false);assert.equal(calls.length,2);
 const bad=await client.callTool({name:'phone_action',arguments:{observationId:'one',action:'text',text:'x',serial:'other'}});
 assert.equal(bad.isError,true);assert.equal(calls.length,2);
});

test('issued input receipt survives partial feedback, and no private payload is copied into text',()=>{
 const result=project({actionIssued:true,effectConfirmed:false,feedback:{status:'captured',frames:[{index:1,image:{mimeType:'image/png',data:'valid-fixture'}},{index:2,image:{mimeType:'image/png',data:''}}]}});
 const metadata=JSON.parse(result.content[0].text);assert.equal(metadata.actionIssued,true);assert.equal(metadata.feedback.status,'partial');
 assert.ok(!result.content[0].text.includes('valid-fixture'));assert.equal(result.content.filter(i=>i.type==='image').length,1);
});

test('parallel MCP calls serialize complete phone invocations',async t=>{
 let active=0,maximum=0;
 const service={status:async()=>{active++;maximum=Math.max(maximum,active);await new Promise(resolve=>setTimeout(resolve,15));active--;return {connected:false};}};
 const {server,dispose}=createPhoneMcpServer({serviceProvider:()=>service});const [one,two]=InMemoryTransport.createLinkedPair();
 const client=new Client({name:'parallel-check',version:'1'});t.after(async()=>{await client.close();await server.close();await dispose();});
 await Promise.all([server.connect(one),client.connect(two)]);
 await Promise.all([1,2].map(()=>client.callTool({name:'phone_status',arguments:{}})));assert.equal(maximum,1);
});
