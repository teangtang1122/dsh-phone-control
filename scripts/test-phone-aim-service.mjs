// Offline service contracts. No device input, processes, network or QQ sends.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAndroidPhoneService } from '../src/android-phone-service.js';
const key = 'private:fixture';
function png(width = 1080, height = 2400) {
  const value = Buffer.alloc(33);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(value);
  value.write('IHDR',12);value.writeUInt32BE(width,16);value.writeUInt32BE(height,20);return value;
}
function fixture() {
  const state = { clock: 1800000000000, image: png(), inputs: [], renders: [], comparisons: [], changed: false, renderError: false, sent: [] };
  const render = async input => {
    state.renders.push(input);
    if (state.renderError) throw Error('private process error');
    return { image: {mimeType:'image/png',data:Buffer.from('rendered fixture').toString('base64')},
      view:{width:500,height:800,region:input.region,coordinateSpace:'view_normalized_1000'} };
  };
  render.compare = async input => {
    state.comparisons.push(input);
    if(state.compareError)throw Error('private compare process error');
    return {sameDimensions:true,changed:state.changed,difference:state.changed ? .2 : 0};
  };
  const service = createAndroidPhoneService({config:()=>({enabled:true,ownerQQ:'fixture',adbPath:'not-executable',serial:'offline'}),
    now:()=>state.clock,wait:async()=>{},renderVisual:render,
    sendScreenshot:async input=>{state.sent.push(input);return {messageId:'1'};},
    run:async (_file,args)=>{
      const command=args[2]==='shell'?args.slice(3).map(v=>v.startsWith("'")?v.slice(1,-1):v):args.slice(2);
      if(command[0]==='get-state')return {stdout:'device'};
      if(command[0]==='dumpsys')return {stdout:''};
      if(command[0]==='uiautomator')return {stdout:'dumped to: /sdcard/qq-fish-window.xml'};
      if(command[0]==='cat')return {stdout:'<hierarchy><node text="确定" enabled="true" clickable="true" bounds="[900,2100][1000,2200]"/></hierarchy>'};
      if(command[0]==='exec-out')return {stdout:state.image};
      if(command[0]==='input'){state.inputs.push(command);return {stdout:''};}
      throw Error('Unexpected offline command');
    }});
  return {service,state,focus:async()=>{const full=await service.observe({key});return service.observe({key,observationId:full.observationId,region:{x:0,y:0,width:1000,height:500}});},observe:args=>service.observe({key,...args}),aim:(id,args={})=>service.act({key,observationId:id,action:'aim',x:170,y:220,targetDescription:'左上角空格',...args}),
    confirm:(id,aimId,args={})=>service.act({key,observationId:id,action:'tap_aimed',aimId,...args})};
}
const rejected=(promise,code)=>assert.rejects(promise,error=>error.code===code);

test('uncropped and slightly trimmed full screens cannot be used to aim',async()=>{
  const f=fixture(),full=await f.observe();
  await rejected(f.aim(full.observationId),'focus_required');
  const slight=await f.observe({observationId:full.observationId,region:{x:0,y:0,width:990,height:990}});
  await rejected(f.aim(slight.observationId),'focus_required');
  assert.equal(f.state.inputs.length,0);
});

test('preview reports measured text at the point instead of calling it an empty cell',async()=>{
  const f=fixture(),full=await f.observe();
  const lower=await f.observe({observationId:full.observationId,region:{x:0,y:500,width:1000,height:500}});
  const aim=await f.aim(lower.observationId,{x:880,y:792,targetDescription:'空格'});
  assert.equal(aim.pointContext.textAtPoint[0].text,'确定');
  assert.equal(aim.actionIssued,false);assert.equal(f.state.inputs.length,0);
});

test('aim renders the mapped point, issues no input and keeps the observation usable',async()=>{
  const f=fixture(),view=await f.focus(),aim=await f.aim(view.observationId);
  assert.equal(aim.actionIssued,false);assert.equal(aim.observationRequired,false);
  assert.deepEqual(aim.point,{x:184,y:264});assert.deepEqual(f.state.renders.at(-1).point,aim.point);
  assert.equal(aim.observationId,view.observationId);assert.equal(f.state.inputs.length,0);
  const result=await f.confirm(view.observationId,aim.aimId);
  assert.deepEqual(f.state.inputs,[['input','tap','184','264']]);
  assert.equal(result.actionIssued,true);assert.equal(result.effectConfirmed,false);
  assert.equal(result.execution.aimId,aim.aimId);assert.equal(result.feedback.frames.length,2);
  assert.equal(f.state.comparisons.length,1);
  await rejected(f.confirm(view.observationId,aim.aimId),'observation');
});

test('crop and nested crop use previous view coordinates, never thumbnail or full-screen coordinates',async()=>{
  const f=fixture(),full=await f.observe();
  const crop=await f.observe({observationId:full.observationId,region:{x:100,y:100,width:800,height:500}});
  assert.deepEqual(crop.view.region,{x:108,y:240,width:864,height:1200});
  const aim=await f.aim(crop.observationId,{x:250,y:250});
  assert.deepEqual(aim.point,{x:324,y:540});
  const nested=await f.observe({observationId:crop.observationId,region:{x:250,y:250,width:500,height:500}});
  assert.deepEqual(nested.view.region,{x:324,y:540,width:432,height:600});
  assert.deepEqual((await f.aim(nested.observationId,{x:1000,y:1000})).point,{x:755,y:1139});
  await rejected(f.confirm(crop.observationId,aim.aimId),'observation');
});

test('malformed/full/out-of-bounds crops and unmatched observation fields never replace a valid observation',async()=>{
  const f=fixture(),view=await f.focus();
  for(const args of [{observationId:view.observationId},{region:{x:0,y:0,width:500,height:500}},
    ...[{x:0,y:0,width:1000,height:1000},{x:500,y:0,width:501,height:100},{x:1.1,y:0,width:100,height:100},
      {x:0,y:0,width:0,height:100},{x:0,y:0,width:100,height:100,extra:1}].map(region=>({observationId:view.observationId,region}))])
    await rejected(f.observe(args),'region');
  assert.equal((await f.aim(view.observationId)).actionIssued,false);
});

test('stale, mismatched, replaced and failed replacement previews never submit input',async()=>{
  const f=fixture(),view=await f.focus();
  await rejected(f.confirm(view.observationId,'invented'),'aim');
  const first=await f.aim(view.observationId),second=await f.aim(view.observationId,{x:400});
  await rejected(f.confirm(view.observationId,first.aimId),'aim');
  await rejected(f.aim(view.observationId,{x:1001}),'coordinates');
  await rejected(f.confirm(view.observationId,second.aimId),'aim');
  const third=await f.aim(view.observationId);f.state.clock+=120001;
  await rejected(f.confirm(view.observationId,third.aimId),'observation');assert.equal(f.state.inputs.length,0);
});

test('changed target or orientation is rejected before input and invalidates the observation',async t=>{
  for(const kind of ['target','orientation'])await t.test(kind,async()=>{
    const f=fixture(),view=await f.focus(),aim=await f.aim(view.observationId);
    if(kind==='target')f.state.changed=true;else f.state.image=png(2400,1080);
    await rejected(f.confirm(view.observationId,aim.aimId),'target_changed');
    await rejected(f.confirm(view.observationId,aim.aimId),'observation');assert.equal(f.state.inputs.length,0);
  });
});

test('crop is rejected if the device rotates after the original observation',async()=>{
  const f=fixture(),view=await f.focus();f.state.image=png(2400,1080);
  await rejected(f.observe({observationId:view.observationId,region:{x:0,y:0,width:500,height:500}}),'target_changed');
  assert.equal(f.state.inputs.length,0);
});

test('preview render and comparison errors cannot result in a tap or leak process errors',async()=>{
  const f=fixture(),view=await f.focus();f.state.renderError=true;
  await rejected(f.aim(view.observationId),'visual');
  f.state.renderError=false;const aim=await f.aim(view.observationId);
  f.state.compareError=true;
  await rejected(f.confirm(view.observationId,aim.aimId),'visual');assert.equal(f.state.inputs.length,0);
  await rejected(f.confirm(view.observationId,aim.aimId),'aim');
});

test('preview accepts only current-view normalized coordinates and confirmation accepts no coordinates',async()=>{
  const f=fixture(),view=await f.focus();
  for(const args of [{x:-1},{y:1001},{x:1.1},{targetDescription:''},{targetDescription:'x'.repeat(161)},{button:'enter'}])
    await assert.rejects(f.aim(view.observationId,args));
  const aim=await f.aim(view.observationId);
  await rejected(f.confirm(view.observationId,aim.aimId,{x:1}),'action');
  for(const action of ['tap','tap_normalized'])await rejected(f.service.act({key,observationId:view.observationId,action,x:1,y:1}),'coordinate_confirmation');
  assert.equal(f.state.inputs.length,0);
});

test('sharing after crop/aim retains the original unannotated screenshot',async()=>{
  const f=fixture(),view=await f.focus();
  const crop=await f.observe({observationId:view.observationId,region:{x:0,y:0,width:500,height:500}});
  await f.aim(crop.observationId);
  await f.service.shareScreenshot({key,observationId:crop.observationId});
  assert.deepEqual(f.state.sent[0].png,f.state.image);assert.equal(f.state.sent[0].width,1080);
  assert.notEqual(f.state.sent[0].png.toString('base64'),crop.image.data);
});

test('text targets continue to click directly without an aim or local-image comparison',async()=>{
  const f=fixture(),view=await f.focus();
  await f.service.act({key,observationId:view.observationId,action:'tap_text',targetText:'确定'});
  assert.deepEqual(f.state.inputs,[['input','tap','950','2150']]);assert.equal(f.state.comparisons.length,0);
});
