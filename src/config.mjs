import fs from 'node:fs';
import path from 'node:path';

const fields=new Set(['adbPath','serial','pythonPath','ocr','scrcpyServerPath']);
export function readConfig(file){
 let input;
 try{input=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}
 catch{throw Error('尚未配置手机。请在工具目录运行 npm run config，或复制 config.example.json 为 config.json 后填写。');}
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!fields.has(k)))throw Error('config.json 包含不支持的字段。请参照 config.example.json。');
 for(const field of ['adbPath','pythonPath']){
  if(typeof input[field]!=='string'||!path.isAbsolute(input[field])||!fs.statSync(input[field],{throwIfNoEntry:false})?.isFile())
   throw Error(`${field} 必须指向本机存在的可执行文件，请重新运行 npm run config。`);
 }
 if(typeof input.serial!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(input.serial)||input.serial.startsWith('REPLACE_'))throw Error('请用 adb devices 查到的真实序列号填写 serial，工具不会自动切换到其他设备。');
 if(input.ocr!==undefined&&typeof input.ocr!=='boolean')throw Error('ocr 必须为 true 或 false。');
 if(input.scrcpyServerPath!==undefined&&typeof input.scrcpyServerPath!=='string')throw Error('scrcpyServerPath 必须为文件路径或空字符串。');
 if(input.scrcpyServerPath&&(!path.isAbsolute(input.scrcpyServerPath)||!fs.statSync(input.scrcpyServerPath,{throwIfNoEntry:false})?.isFile()))throw Error('scrcpyServerPath 必须指向 scrcpy 4.1 的服务端文件；不需要中文输入时可以留空。');
 if(input.scrcpyServerPath&&!/^[A-Za-z0-9_.-]+$/.test(input.serial))throw Error('当前 scrcpy 中文输入模块仅验证过 USB 序列号；网络设备请先留空 scrcpyServerPath。');
 return {enabled:true,ownerQQ:'local-owner',adbPath:input.adbPath,serial:input.serial,pythonPath:input.pythonPath,
  ocr:input.ocr!==false,scrcpyServerPath:input.scrcpyServerPath||''};
}
