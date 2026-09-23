import fs from 'node:fs';
import solc from 'solc';

const names=['AssetFareDirectSwapExecutorV2','AssetFareDirectCctpExecutorV2','AssetFareDirectUsdgOftExecutorV2'];
const sources=Object.fromEntries(names.map(name=>[`${name}.sol`,{content:fs.readFileSync(new URL(`./contracts/${name}.sol`,import.meta.url),'utf8')}]))
const input={language:'Solidity',sources,settings:{optimizer:{enabled:true,runs:200},outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}}};
const output=JSON.parse(solc.compile(JSON.stringify(input))),errors=(output.errors??[]).filter(row=>row.severity==='error');
if(errors.length)throw Error(errors.map(row=>row.formattedMessage).join('\n'));
const result={};
for(const name of names){const compiled=output.contracts[`${name}.sol`][name],artifact={abi:compiled.abi,bytecode:`0x${compiled.evm.bytecode.object}`,deployedBytecode:`0x${compiled.evm.deployedBytecode.object}`},target=new URL(`./artifacts/${name}.json`,import.meta.url);fs.writeFileSync(target,JSON.stringify(artifact,null,2)+'\n');result[name]={creationBytes:compiled.evm.bytecode.object.length/2,runtimeBytes:compiled.evm.deployedBytecode.object.length/2,artifact:new URL(target).pathname};}
console.log(JSON.stringify({status:'pass',compiler:solc.version(),contracts:result}));
