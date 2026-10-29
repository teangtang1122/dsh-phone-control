import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readConfig} from '../src/config.mjs';
const root=path.resolve(import.meta.dirname,'..');
const run=promisify(execFile);
try{
 const cfg=readConfig(path.join(root,'config.json'));
 const result=await run(cfg.adbPath,['-s',cfg.serial,'get-state'],{windowsHide:true,encoding:'utf8',timeout:8000});
 if(result.stdout.trim()!=='device')throw Error('固定设备未连接，请在手机上确认 USB 调试授权。');
 await run(cfg.pythonPath,['-c','from PIL import Image; print("Pillow OK")'],{windowsHide:true,encoding:'utf8',timeout:10000});
 let ocrAvailable=false;
 if(cfg.ocr){
  try{await run(cfg.pythonPath,['-c','import rapidocr_onnxruntime; import numpy; print("OCR OK")'],{windowsHide:true,encoding:'utf8',timeout:15000});ocrAvailable=true;}
  catch{console.warn('OCR 依赖未安装或不可用；可以先设置 ocr=false，或在同一个 Python 中安装 requirements.txt。');}
 }
 console.log(JSON.stringify({connected:true,visualReady:true,ocrEnabled:cfg.ocr,ocrAvailable,unicodeInputConfigured:!!cfg.scrcpyServerPath}));
 console.log(cfg.scrcpyServerPath?'中文/emoji输入：已配置 scrcpy 服务端路径；本次只读检查未验证实际粘贴。':'中文/emoji输入：未启用。请另行下载 scrcpy 4.1 并填写 scrcpyServerPath；基础点按等操作不受影响。');
 console.log('只读检查完成；没有向手机发送输入。');
 if(cfg.ocr&&!ocrAvailable)process.exitCode=1;
}catch(e){console.error(e.message?.includes('config')||!e.cmd?e.message:'环境检查失败。请核对固定设备连接，以及配置中的 Python 和依赖。');process.exitCode=1;}
