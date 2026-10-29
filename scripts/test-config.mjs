import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readConfig} from '../src/config.mjs';
test('local config fixes ownership, rejects placeholders and cannot override service authorization',t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'phone-config-test-'));const file=path.join(directory,'config.json');
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const valid={adbPath:process.execPath,pythonPath:process.execPath,serial:'OFFLINE_TEST_DEVICE',ocr:false,scrcpyServerPath:''};
 fs.writeFileSync(file,JSON.stringify(valid));const cfg=readConfig(file);assert.equal(cfg.ownerQQ,'local-owner');assert.equal(cfg.enabled,true);
 for(const edit of [{serial:'REPLACE_WITH_YOUR_DEVICE_SERIAL'},{serial:''},{serial:'phone;id'},{ownerQQ:'someone-else'},
  {pythonPath:'relative.exe'},{adbPath:path.join(directory,'missing.exe')},{ocr:'yes'},{scrcpyServerPath:1}]){
  fs.writeFileSync(file,JSON.stringify({...valid,...edit}));assert.throws(()=>readConfig(file));
 }
});
