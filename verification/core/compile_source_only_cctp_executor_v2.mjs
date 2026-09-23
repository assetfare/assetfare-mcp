import fs from 'node:fs';
import solc from 'solc';

const name='AssetFareSourceOnlyCctpExecutorV2';
const source=fs.readFileSync(new URL(`./contracts/${name}.sol`,import.meta.url),'utf8');
const input={language:'Solidity',sources:{[`${name}.sol`]:{content:source}},settings:{optimizer:{enabled:true,runs:200},outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}}};
const output=JSON.parse(solc.compile(JSON.stringify(input)));
const errors=(output.errors??[]).filter(x=>x.severity==='error');
if(errors.length)throw Error(errors.map(x=>x.formattedMessage).join('\n'));
const artifact=output.contracts[`${name}.sol`][name];
const target=new URL(`./artifacts/${name}.json`,import.meta.url);
fs.writeFileSync(target,JSON.stringify({abi:artifact.abi,bytecode:'0x'+artifact.evm.bytecode.object,deployedBytecode:'0x'+artifact.evm.deployedBytecode.object},null,2)+'\n');
process.stdout.write(JSON.stringify({status:'pass',compiler:solc.version(),creationBytes:artifact.evm.bytecode.object.length/2,runtimeBytes:artifact.evm.deployedBytecode.object.length/2,artifact:new URL(target).pathname})+'\n');
