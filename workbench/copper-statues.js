import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {javaReleases} from './minecraft-version.js';

const statue=/^(?:waxed_)?(?:(exposed|weathered|oxidized)_)?copper_golem_statue$/;
const units=n=>n/16;
const standing={bodyY:8,headY:13.5,headZ:0,arms:[0,0,0],legs:[0,0,0]};
const poses={
 standing,
 sitting:{bodyY:5,headY:10,headZ:-2,arms:[.7,.7,0],legs:[Math.PI/2,Math.PI/2,0]},
 running:{bodyY:8,headY:13,headZ:-1.5,arms:[.95,-.85,0],legs:[-.84,.77,0]},
 star:{bodyY:8,headY:13.5,headZ:0,arms:[0,0,1.8],legs:[0,0,.25]}
};

// The block model specifies particle appearance. The preview maps the installed
// entity skin to body parts and poses, with the feet at the block's base.
export function copperStatueModel(id,props,makeMaterial,cuboid,orient,minecraft){
 const identity=statue.exec(id);
 if(!identity)return null;
 const pose=Object.hasOwn(poses,props.copper_golem_pose)?poses[props.copper_golem_pose]:standing;
 const box=(size,center,uv)=>cuboid(size.map(units),center.map(units),size,uv);
 const {headY,headZ}=pose;
 const parts=[
  box([8,6,6],[0,pose.bodyY,0],[0,15]),
  box([8,5,10],[0,headY,headZ],[0,0]),
  box([2,3,2],[0,headY-1.5,headZ-5.3],[56,0]),
  box([2,4,2],[0,headY+4.5,headZ],[37,8]),
  box([4,4,4],[0,headY+8.5,headZ],[37,0])
 ];
 for(const [i,side] of [-1,1].entries()){
  const arm=box([3,10,4],[0,-4,0],i?[36,16]:[50,16])
   .rotateX(pose.arms[i]).rotateZ(side*pose.arms[2])
   .translate(units(side*5.5),units(pose.bodyY+3),units(pose.headZ/2));
  const hip=pose===poses.sitting?[2.5,-1.5]:[5,0];
  const leg=box([4,5,4],[0,-2.5,0],i?[0,27]:[16,27])
   .rotateX(pose.legs[i]).rotateZ(side*pose.legs[2])
   .translate(units(side*2),units(hip[0]),units(hip[1]));
  parts.push(arm,leg);
 }
 const geometry=mergeGeometries(parts);
 for(const part of parts)part.dispose();
 geometry.computeBoundingBox();
 geometry.translate(.5,-geometry.boundingBox.min.y,.5);
 const stage=identity[1],legacySkin=javaReleases[minecraft]<javaReleases['26.1'];
 const name=stage?(legacySkin?stage+'_copper_golem':'copper_golem_'+stage):'copper_golem';
 return [{geometry:orient(geometry,props.facing),material:makeMaterial('entity/copper_golem/'+name,id,false)}];
}
