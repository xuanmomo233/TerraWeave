export const baselineMinecraft='1.20.1';

// DataVersion values from version.json in Mojang's published client archives.
export const javaReleases=Object.freeze({
 '1.20.1':3465,'1.20.2':3578,'1.20.3':3698,'1.20.4':3700,'1.20.5':3837,'1.20.6':3839,
 '1.21':3953,'1.21.1':3955,'1.21.2':4080,'1.21.3':4082,'1.21.4':4189,'1.21.5':4325,
 '1.21.6':4435,'1.21.7':4438,'1.21.8':4440,'1.21.9':4554,'1.21.10':4556,'1.21.11':4671,
 '26.1':4786,'26.1.1':4788,'26.1.2':4790,'26.2':4903
});

export function supportedMinecraft(name){
 return typeof name==='string'&&Object.hasOwn(javaReleases,name);
}

export function supportedDataVersion(version){
 // The boundary comes from version.json in Mojang's 1.20.1 and 26.2 clients.
 return Number.isInteger(version)&&version>=3465&&version<=4903;
}

export function completeAnvilChunk(chunk){
 return supportedDataVersion(chunk?.DataVersion)
  &&['full','minecraft:full'].includes(chunk.Status)
  &&Array.isArray(chunk.sections);
}
