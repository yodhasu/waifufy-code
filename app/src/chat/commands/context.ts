import type { CommandHost } from './index'

/** Stub: filled in by its V0.5 work package (docs/V0.5.md). `name` is the command as typed (an alias picks a tab). */
export function contextCommand(host: CommandHost, args: string, name: string) {
  host.toast(`/${name}${args ? ` ${args}` : ''} is not built yet`)
}
