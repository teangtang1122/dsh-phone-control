import {spawn} from 'node:child_process';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export function createAndroidPhoneOcr({root,pythonPath}){
 let worker=null,pending=null,buffer='',queue=Promise.resolve(),closed=false;
 function stop(){const old=worker;worker=null;buffer='';old?.kill();if(pending){clearTimeout(pending.timer);pending.reject(Error('本地 OCR 暂时不可用'));pending=null;}}
 function start(){
  if(worker)return;if(closed)throw Error('OCR 已关闭');
  const own=spawn(pythonPath,['-B','-u',path.join(root,'scripts/phone-ocr.py')],{windowsHide:true,stdio:['pipe','pipe','ignore']});worker=own;
  own.on('error',()=>{if(worker===own)stop();});own.on('exit',()=>{if(worker===own)stop();});own.stdin.on('error',()=>{if(worker===own)stop();});
  own.stdout.on('data',chunk=>{
   if(worker!==own)return;buffer+=chunk.toString('utf8');if(buffer.length>1024*1024){stop();return;}
   let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
    let result;try{result=JSON.parse(line);}catch{stop();return;}
    if(!pending||result.id!==pending.id){stop();return;}
    const done=pending;pending=null;clearTimeout(done.timer);result.error?done.reject(Error('本地 OCR 暂时不可用')):done.resolve(result.nodes??[]);
   }
  });
 }
 const recognize=png=>{
  const task=queue.then(()=>{start();return new Promise((resolve,reject)=>{
   const own=worker,id=randomUUID(),timer=setTimeout(()=>{if(worker===own&&pending?.id===id)stop();},25000);pending={id,timer,resolve,reject};
   own.stdin.write(JSON.stringify({id,data:png.toString('base64')})+'\n',error=>{if(error&&worker===own)stop();});
  });});queue=task.catch(()=>{});return task;
 };
 recognize.close=()=>{closed=true;stop();};return recognize;
}
