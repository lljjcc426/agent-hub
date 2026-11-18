import {readFileSync} from 'node:fs'

export const interactionStyles = readFileSync(new URL('./interaction.css', import.meta.url), 'utf8')
