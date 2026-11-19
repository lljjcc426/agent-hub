export interface ChatSkillRef {
  id: string
  name: string
}

export interface ChatSkill extends ChatSkillRef {
  description?: string
  source: string
}

export interface ChatSkillCatalog {
  items: ChatSkill[]
  refreshing: boolean
}

export interface SelectedChatSkill extends ChatSkillRef {
  instructions: string
  file?: string
}
