import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const quote=value=>"'"+value.replaceAll("'","''")+"'";
console.log([
 '# Append this block to your DSH profile cordis.patch.yml; do not overwrite existing settings.',
 '- insert:',
 '    - id: mcp-phone-control',
 "      name: '@deepseek-ai/dsh-mcp-client'",
 '      config:',
 '        serverName: phone',
 '        transport: stdio',
 '        command: '+quote(process.execPath),
 '        args:',
 '          - '+quote(path.join(root,'src/server.mjs')),
 '        toolCallTimeoutMs: 180000',
].join('\n'));
