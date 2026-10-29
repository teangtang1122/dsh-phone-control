// Source-only release, built from an explicit allowlist. No runtime state.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'..');
const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Invalid release version');
const files=['package.json','package-lock.json','README.md','LICENSE','NOTICE','THIRD_PARTY_NOTICES.md','config.example.json','requirements.txt','.gitignore'];
function walk(relative){
 for(const entry of fs.readdirSync(path.join(root,relative),{withFileTypes:true})){
  const child=relative+'/'+entry.name;
  if(entry.isSymbolicLink())throw Error('Source symlink is not allowed: '+child);
  if(entry.isDirectory()){
   if(entry.name==='__pycache__')continue;
   walk(child);
  }else if(/\.(?:js|mjs|py|md|json|txt)$/.test(entry.name))files.push(child);
 }
}
for(const folder of ['src','scripts','docs','LICENSES'])walk(folder);
files.sort();
for(const relative of files){
 const file=path.join(root,relative),stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink())throw Error('Not an ordinary source file: '+relative);
 if(stat.size>1024*1024)throw Error('Unexpected large source file: '+relative);
 if(relative!=='config.example.json'&&/(^|\/)config(?:\.local)?\.json$/.test(relative))throw Error('Local config cannot be released');
 const text=fs.readFileSync(file,'utf8');
 if(/\b(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/.test(text))throw Error('Possible credential in '+relative);
}
const out=path.join(root,'dist');fs.mkdirSync(out,{recursive:true});
const name='dsh-phone-control-'+version;
const archive=path.join(out,name+(process.platform==='win32'?'.zip':'.tar.gz'));
if(fs.existsSync(archive))fs.unlinkSync(archive);
if(process.platform==='win32'){
 const ps=`$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression
$info=[Console]::In.ReadToEnd() | ConvertFrom-Json
$stream=[IO.File]::Open($info.output,[IO.FileMode]::CreateNew)
try{
 $zip=New-Object IO.Compression.ZipArchive($stream,[IO.Compression.ZipArchiveMode]::Create,$false)
 try{foreach($file in $info.files){
  $entry=$zip.CreateEntry(($info.name+'/'+$file),[IO.Compression.CompressionLevel]::Optimal)
  $target=$entry.Open();$source=[IO.File]::OpenRead((Join-Path $info.root $file))
  try{$source.CopyTo($target)}finally{$source.Dispose();$target.Dispose()}
 }}finally{$zip.Dispose()}
}finally{$stream.Dispose()}`;
 const result=spawnSync('powershell.exe',['-NoProfile','-Command',ps],{input:JSON.stringify({root,output:archive,name,files}),encoding:'utf8',windowsHide:true,timeout:30000});
 if(result.status!==0)throw Error('Source ZIP creation failed');
}else{
 const result=spawnSync('tar',['-czf',archive,'-C',root,...files],{encoding:'utf8',timeout:30000});
 if(result.status!==0)throw Error('Source archive creation failed');
}
const digest=createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
fs.writeFileSync(path.join(out,'SHA256SUMS.txt'),digest+'  '+path.basename(archive)+'\n');
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify({version,files,archive:path.basename(archive),sha256:digest},null,2)+'\n');
console.log(JSON.stringify({archive,files:files.length,bytes:fs.statSync(archive).size,sha256:digest}));
