// Synthetic pixels only: exercises the actual Python workers, never a phone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createAndroidPhoneVisual} from '../src/android-phone-visual.js';
import {createAndroidPhoneOcr} from '../src/android-phone-ocr.js';
const root=path.resolve(import.meta.dirname,'..');
const python=process.env.PHONE_TEST_PYTHON||path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
test('real Pillow preview, local-image comparison and OCR use only synthetic images',async t=>{
 if(!fs.existsSync(python)){t.skip('Install requirements.txt in .venv to exercise Python workers.');return;}
 const code="import sys,io;from PIL import Image,ImageDraw,ImageFont;im=Image.new('RGB',(400,200),'white');d=ImageDraw.Draw(im);d.text((70,70),'TEST',font=ImageFont.load_default(size=45),fill='black');b=io.BytesIO();im.save(b,format='PNG');sys.stdout.buffer.write(b.getvalue())";
 const png=execFileSync(python,['-c',code],{windowsHide:true,maxBuffer:1024*1024});
 const visual=createAndroidPhoneVisual({root,pythonPath:python}),ocr=createAndroidPhoneOcr({root,pythonPath:python});
 t.after(()=>{visual.close();ocr.close();});
 const result=await visual({png,region:{x:40,y:40,width:300,height:120},point:{x:150,y:100}});
 assert.equal(result.view.coordinateSpace,'view_normalized_1000');assert.deepEqual(result.view.region,{x:40,y:40,width:300,height:120});
 assert.ok(result.image.data.length>100);assert.deepEqual(await visual.compare({before:png,after:png,point:{x:150,y:100}}),{sameDimensions:true,changed:false,difference:0});
 const words=await ocr(png);assert.ok(words.some(n=>n.text.includes('TEST')));assert.ok(words.every(n=>n.bounds.left>=0&&n.bounds.right<=400));
});
