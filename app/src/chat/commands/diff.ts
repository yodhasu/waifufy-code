import type { CommandHost } from './index'

/** Stub: filled in by its V0.5 work package (docs/V0.5.md). `typed` is the command as typed. */
export function diffCommand(host: CommandHost, args: string, typed: string) {
  host.toast(`/${typed}${args ? ` ${args}` : ''} is not built yet`)
}
