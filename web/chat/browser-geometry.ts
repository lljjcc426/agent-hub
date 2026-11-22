export function browserImageArea(
  rect: {x:number;y:number;width:number;height:number},
  image: {width:number;height:number},
) {
  if (![image.width,image.height,rect.width,rect.height].every(v=>Number.isFinite(v)&&v>0)) return null
  const scale=Math.min(rect.width/image.width,rect.height/image.height)
  const width=image.width*scale,height=image.height*scale
  return {x:rect.x+(rect.width-width)/2,y:rect.y+(rect.height-height)/2,width,height,scale}
}

/** Screencast image height may exclude browser chrome included in deviceHeight. */
export function browserPoint(
  client: {x:number;y:number},
  rect: {x:number;y:number;width:number;height:number},
  image: {width:number;height:number},
  deviceWidth:number,
) {
  const area=browserImageArea(rect,image)
  if(!area||!Number.isFinite(deviceWidth)||deviceWidth<=0)return null
  const x=(client.x-area.x)/area.scale
  const y=(client.y-area.y)/area.scale
  if(x<0||y<0||x>=image.width||y>=image.height)return null
  return {x:x*deviceWidth/image.width,y:y*deviceWidth/image.width}
}
