import { version } from '../../../package.json'

export const APP_NAME = 'Cairn'
export const APP_TAGLINE = 'Plan clearly. Work simply.'
/** `version` of package.json, inlined at build time (named import: nothing else is bundled). */
export const APP_VERSION: string = version
