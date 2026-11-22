import {it,expect} from 'vitest'
import {browserImageArea,browserPoint,browserPointerDuration} from '../web/chat/browser-geometry.ts'

it('maps a letterboxed screencast to page coordinates using actual image dimensions',()=>{
  const point=browserPoint({x:1140.3421875,y:587.533056640625},{x:821,y:310,width:679,height:592},{width:1280,height:633},1280)
  expect(point?.x).toBeCloseTo(602);expect(point?.y).toBeCloseTo(281.6875)
})
it('scales compressed frames and rejects clicks outside the actual page',()=>{
  expect(browserPoint({x:150,y:100},{x:0,y:0,width:400,height:300},{width:800,height:600},1600)).toEqual({x:600,y:400})
  expect(browserPoint({x:10,y:10},{x:0,y:0,width:400,height:500},{width:800,height:400},800)).toBeNull()
  expect(browserPoint({x:0,y:0},{x:0,y:0,width:400,height:500},{width:0,height:0},800)).toBeNull()
})
it('keeps cursor coordinates aligned when the live stream switches to a high resolution frame',()=>{
  const rect={x:12,y:80,width:1320,height:800},fast={width:1000,height:640},detail={width:2000,height:1280}
  const area=browserImageArea(rect,detail)!
  const location={x:area.x+.24*area.width,y:area.y+.68*area.height}
  for(const dimensions of [fast,detail]){
    const page=browserPoint(location,rect,dimensions,1000)
    expect(page?.x).toBeCloseTo(240)
    expect(page?.y).toBeCloseTo(435.2)
  }
})
it('slows down long assistant pointer moves while keeping the transition bounded',()=>{
  const start={x:0,y:0}
  expect(browserPointerDuration(start,{x:20,y:16})).toBe(320)
  expect(browserPointerDuration(start,{x:400,y:300})).toBe(590)
  expect(browserPointerDuration(start,{x:1400,y:0})).toBe(780)
})
