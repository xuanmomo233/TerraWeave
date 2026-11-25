import catalog from './design-block-catalog.json' with {type:'json'};

export function versionIndex(version){
 const index=catalog.versions.findIndex(([id])=>id===version);
 if(index===-1)throw Error('没有对应版本的官方方块表 '+(version??'（未记录版本）'));
 return index;
}

export function blockRule(id,version){
 if(!Object.hasOwn(catalog.blocks,id))return;
 const range=catalog.blocks[id].find(([from,to])=>version>=from&&version<=to);
 return range&&catalog.rules[range[2]];
}

export function registryContains(version,name,id){
 const release=versionIndex(version),entries=catalog.registries[name];
 return Object.hasOwn(entries,id)&&!!(entries[id]&1<<release);
}

export function modelProperties(id,properties,version){
 // A missing property in a saved palette entry uses that release's default.
 const defaults=blockRule(id,versionIndex(version))?.[1];
 return defaults?{...defaults,...properties}:properties;
}
