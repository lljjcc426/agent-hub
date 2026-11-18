export const capabilityKinds=['mcp','skill','plugin','app','tool'] as const
export type CapabilityKind=typeof capabilityKinds[number]
export type CapabilityStatus='builtin'|'configured'|'cli'|'connected'|'disabled'|'conditional'|'unavailable'|'candidate'|'installed'|'declared'|'cached'
export interface CapabilityTool {name:string;description?:string;inputs?:{name:string;type?:string;required:boolean}[]}
export interface Capability {
  id:string;kind:CapabilityKind;name:string;source:string;status:CapabilityStatus;description?:string
  roles?:string[];version?:string;tools?:CapabilityTool[];facts?:string[];hasContent?:boolean
  steps?:string[];inputs?:string[];criteria?:string[];inspectable?:boolean
}
export interface CapabilitySnapshot {items:Capability[];warnings:string[];refreshing:boolean}
