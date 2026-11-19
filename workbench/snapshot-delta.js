const maxChanges = 512;

export function snapshotDelta(before, after) {
 if (!before || !after || before.uuid !== after.uuid || before.world !== after.world ||
     before.minecraft !== after.minecraft || !!before.context_blocks !== !!after.context_blocks ||
     JSON.stringify(before.block_entities??{})!==JSON.stringify(after.block_entities??{}) ||
     !before.bounds.every((n,i) => n === after.bounds[i])) return null;

 let remaining = maxChanges;
 function compare(from, to) {
  const changes = [];
  for (const key in to) {
   if (to[key] === from[key]) continue;
   if (--remaining < 0) return null;
   changes.push([key,to[key]]);
  }
  for (const key in from) {
   if (Object.hasOwn(to,key)) continue;
   if (--remaining < 0) return null;
   changes.push([key,null]);
  }
  return changes;
 }
 const blocks = compare(before.blocks,after.blocks);
 if (!blocks) return null;
 const context_blocks = compare(before.context_blocks ?? {},after.context_blocks ?? {});
 return context_blocks ? {blocks,context_blocks} : null;
}

export function applySnapshotDelta(snapshot, delta) {
 function patch(original, changes) {
  if (!changes.length) return original;
  const result = {...original};
  for (const [key,state] of changes) {
   if (state === null) delete result[key];
   else result[key] = state;
  }
  return result;
 }
 return {
  ...snapshot,
  blocks:patch(snapshot.blocks,delta.blocks),
  context_blocks:patch(snapshot.context_blocks,delta.context_blocks)
 };
}

export function affectedChunkColumns(delta) {
 const columns = new Set();
 for (const changes of [delta.blocks,delta.context_blocks]) for (const [key] of changes) {
  const [x,,z] = key.split(',').map(Number);
  // A fluid corner samples diagonal neighbors as well as the block immediately above.
  for (let cx=Math.floor((x-1)/16); cx<=Math.floor((x+1)/16); cx++) {
   for (let cz=Math.floor((z-1)/16); cz<=Math.floor((z+1)/16); cz++) columns.add(`${cx},${cz}`);
  }
 }
 return columns;
}
