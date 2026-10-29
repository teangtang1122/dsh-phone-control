import fs from 'node:fs';
import path from 'node:path';
import {createInterface} from 'node:readline/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readConfig} from '../src/config.mjs';
const root=path.resolve(import.meta.dirname,'..'),file=path.join(root,'config.json');
const input=createInterface({input:process.stdin,output:process.stdout});
const clean=value=>value.trim().replace(/^"(.*)"$/,'$1');
try{
 if(fs.existsSync(file))throw Error('config.json 已存在，请直接编辑；本向导不会覆盖你的设备绑定。');
 console.log('配置你自己的安卓手机。此向导只列出设备，不会点击手机。');
 const adbPath=clean(await input.question('adb.exe 的完整路径：'));
 const pythonPath=clean(await input.question('Python 解释器完整路径（建议 .venv/Scripts/python.exe）：'));
 const result=await promisify(execFile)(adbPath,['devices'],{windowsHide:true,encoding:'utf8',timeout:10000});
 console.log(result.stdout.trim());
 const serial=clean(await input.question('填写你要固定绑定的设备序列号：'));
 const scrcpyServerPath=clean(await input.question('scrcpy 4.1 服务端文件完整路径（中文/emoji输入必需；仅基础操作时按回车）：'));
 const value={adbPath,serial,pythonPath,ocr:true,scrcpyServerPath};
 const temp=path.join(root,'config.local.json');
 try{fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});readConfig(temp);fs.renameSync(temp,file);}
 finally{try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}}
 console.log('配置完成。下一步运行 npm run doctor。');
}catch(e){console.error(e.message||'配置未完成');process.exitCode=1;}
finally{input.close();}
