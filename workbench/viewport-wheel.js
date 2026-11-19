const key='terraweave-wheel-sensitivity';
export function wheelSensitivity(value){const n=Number(value);return Number.isFinite(n)&&n>0?Math.max(1,Math.min(100,n)):20;}
export function readWheelSensitivity(){try{return wheelSensitivity(localStorage.getItem(key));}catch{return 20;}}
export function saveWheelSensitivity(value){const n=wheelSensitivity(value);try{localStorage.setItem(key,String(n));}catch{}return n;}
export function wheelSteps(event){const delta=event.deltaY*(event.deltaMode===1?100/3:event.deltaMode===2?300:1);return Math.max(-3,Math.min(3,delta/100));}
export const wheelZoomFactor=(event,sensitivity=readWheelSensitivity())=>Math.exp(wheelSteps(event)*.1*wheelSensitivity(sensitivity)/100);
export const wheelTravel=(event,sensitivity=readWheelSensitivity())=>-wheelSteps(event)*2*wheelSensitivity(sensitivity)/100;
