// Check shipped PE imports without using the build machine's installed VC++ runtime.
// Each --root is one unpacked distribution; --file checks a standalone executable.
import { lstat, opendir, readFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const limits = { fileBytes: 512 * 1024 * 1024, totalBytes: 4 * 1024 ** 3, files: 4096, entries: 100_000, depth: 48, imports: 4096 }
// Windows 10/11 OS components, not everything found in a developer VM's System32.
// In particular vcruntime*, msvcp*, concrt* and msvcr<number>* must be shipped.
const systemLibraries = new Set(`
  advapi32.dll avrt.dll bcrypt.dll bcryptprimitives.dll cabinet.dll cfgmgr32.dll
  clbcatq.dll combase.dll comctl32.dll comdlg32.dll coremessaging.dll crypt32.dll
  cryptbase.dll cryptnet.dll cryptsp.dll d2d1.dll d3d11.dll d3d12.dll d3d9.dll
  d3dcompiler_47.dll dbghelp.dll dcomp.dll dhcpcsvc.dll dnsapi.dll dsound.dll
  dwmapi.dll dxcore.dll dxgi.dll dxva2.dll evr.dll fwpuclnt.dll gdi32.dll
  gdi32full.dll hid.dll imagehlp.dll imm32.dll iphlpapi.dll kernel32.dll
  kernelbase.dll ksuser.dll mf.dll mfcore.dll mfplat.dll mfreadwrite.dll
  mfuuid.dll mmdevapi.dll mpr.dll msasn1.dll msimg32.dll msvcrt.dll mswsock.dll
  ncrypt.dll netapi32.dll normaliz.dll nsi.dll ntasn1.dll ntdll.dll ntmarta.dll
  ole32.dll oleacc.dll oleaut32.dll opengl32.dll powrprof.dll profapi.dll propsys.dll
  psapi.dll rasapi32.dll rpcrt4.dll rsaenh.dll samcli.dll secur32.dll setupapi.dll
  shcore.dll shell32.dll shlwapi.dll srvcli.dll sspicli.dll ucrtbase.dll urlmon.dll
  user32.dll userenv.dll usp10.dll uxtheme.dll version.dll wevtapi.dll win32u.dll
  windows.storage.dll windowscodecs.dll winhttp.dll wininet.dll winmm.dll
  winspool.drv wintrust.dll wkscli.dll wldap32.dll wldp.dll ws2_32.dll wsock32.dll
  wtsapi32.dll xmllite.dll
`.trim().split(/\s+/))

export function isWindowsSystemLibrary(name) {
  const lower = name.toLowerCase()
  // API sets are loader contracts supplied by Windows, including the OS UCRT.
  return systemLibraries.has(lower) || /^(?:api|ext)-ms-win-[a-z0-9-]+-l\d+-\d+-\d+\.dll$/.test(lower)
}

/** Read PE32/PE32+ ordinary and delay-load DLL names. All offsets are bounded. */
export function inspectPE(bytes, label = 'PE image') {
  const invalid = detail => { throw new Error(`${label}: invalid PE image (${detail})`) }
  const range = (offset, size) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > bytes.length) invalid('truncated or out-of-range data')
  }
  const u16 = offset => { range(offset, 2); return bytes.readUInt16LE(offset) }
  const u32 = offset => { range(offset, 4); return bytes.readUInt32LE(offset) }
  range(0, 64)
  if (bytes.length > limits.fileBytes || u16(0) !== 0x5a4d) invalid('missing DOS signature or file too large')
  const pe = u32(0x3c)
  if (pe < 64 || u32(pe) !== 0x4550) invalid('missing PE signature')
  const coff = pe + 4, optional = coff + 20
  const machine = u16(coff), sections = u16(coff + 2), optionalSize = u16(coff + 16)
  if (![0x14c, 0x8664].includes(machine) || sections < 1 || sections > 96) invalid('unsupported machine or section count')
  range(optional, optionalSize)
  const magic = u16(optional), plus = magic === 0x20b
  if ((!plus && magic !== 0x10b) || plus !== (machine === 0x8664)) invalid('unsupported optional header')
  const directoryOffset = plus ? 112 : 96
  if (optionalSize < directoryOffset) invalid('short optional header')
  const directoryCount = u32(optional + directoryOffset - 4)
  if (directoryCount > 16 || directoryOffset + directoryCount * 8 > optionalSize) invalid('invalid data directory count')
  const imageBase = plus ? bytes.readBigUInt64LE(optional + 24) : BigInt(u32(optional + 28))
  const headerSize = u32(optional + 60)
  const sectionOffset = optional + optionalSize
  range(sectionOffset, sections * 40)
  if (headerSize < sectionOffset + sections * 40 || headerSize > bytes.length) invalid('invalid header size')
  const mappings = []
  for (let index = 0; index < sections; index++) {
    const offset = sectionOffset + index * 40
    const address = u32(offset + 12), size = u32(offset + 16), file = u32(offset + 20)
    range(file, size)
    if (address + size > 0x1_0000_0000) invalid('overflowing section')
    if (size && mappings.some(previous => address < previous.address + previous.size && previous.address < address + size)) invalid('overlapping sections')
    mappings.push({ address, size, file })
  }
  const mapped = (rva, size = 1) => {
    if (!Number.isSafeInteger(rva) || rva < 0 || rva > 0xffffffff) invalid('invalid RVA')
    if (rva < headerSize && size <= headerSize - rva) return { offset: rva, available: headerSize - rva }
    const section = mappings.find(item => rva >= item.address && size <= item.size - (rva - item.address))
    if (!section) invalid('RVA is not backed by file bytes')
    return { offset: section.file + rva - section.address, available: section.size - (rva - section.address) }
  }
  const nameAt = rva => {
    if (!rva) invalid('missing import name')
    const { offset, available } = mapped(rva)
    const length = bytes.subarray(offset, offset + Math.min(261, available)).indexOf(0)
    if (length < 0) invalid('unterminated import name')
    const name = bytes.toString('latin1', offset, offset + length).toLowerCase()
    if (!/^[a-z0-9_.+-]+\.(?:dll|exe|drv)$/.test(name)) invalid('invalid imported library name')
    return name
  }
  const imports = []
  for (const [directory, stride, delay] of [[1, 20, false], [13, 32, true]]) {
    if (directory >= directoryCount) continue
    const address = u32(optional + directoryOffset + directory * 8)
    const size = u32(optional + directoryOffset + directory * 8 + 4)
    if (!address && !size) continue
    if (!address || size < stride || size > limits.imports * stride) invalid('invalid import directory size')
    let terminated = false
    for (let index = 0; index < limits.imports && (index + 1) * stride <= size; index++) {
      const { offset } = mapped(address + index * stride, stride)
      if (bytes.subarray(offset, offset + stride).every(byte => byte === 0)) { terminated = true; break }
      let name = u32(offset + (delay ? 4 : 12))
      if (delay) {
        const attributes = u32(offset)
        if (attributes & ~1) invalid('unsupported delay import attributes')
        if (!(attributes & 1)) {
          const rva = BigInt(name) - imageBase
          if (rva < 0n || rva > 0xffffffffn) invalid('invalid delay import virtual address')
          name = Number(rva)
        }
      }
      imports.push({ name: nameAt(name), delay })
    }
    if (!terminated) invalid('import directory has no terminator within its bounds')
  }
  return { machine, imports }
}

/** Verify each distribution independently, including every DLL/addon it contains. */
export async function checkWindowsDependencies({ roots = [], files = [] }, budget = limits) {
  budget = { ...limits, ...budget }
  if (!roots.length && !files.length) throw new Error('Specify at least one --root or --file')
  const report = { files: 0, imports: 0, scopes: [] }
  let entries = 0, totalBytes = 0
  const inspect = async (file, metadata) => {
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${file}: expected a regular PE file`)
    if (++report.files > budget.files || metadata.size > budget.fileBytes || (totalBytes += metadata.size) > budget.totalBytes) throw new Error('Windows dependency scan exceeded its file or byte limit')
    return { file, ...inspectPE(await readFile(file), file) }
  }
  const check = (scope, records) => {
    if (!records.length) throw new Error(`${scope}: no Windows PE files found`)
    const byDirectory = new Map()
    for (const record of records) {
      const directory = dirname(record.file).toLowerCase()
      if (!byDirectory.has(directory)) byDirectory.set(directory, [])
      byDirectory.get(directory).push(record)
    }
    const missing = []
    for (const record of records) {
      // Model the module directory and its nearest packaged executable host.
      // A DLL in another edition, nested runtime or unrelated folder cannot help.
      const search = [dirname(record.file).toLowerCase()]
      let parent = dirname(record.file)
      while (parent.startsWith(scope) && !byDirectory.get(parent.toLowerCase())?.some(item => extname(item.file).toLowerCase() === '.exe')) {
        const next = dirname(parent)
        if (next === parent) break
        parent = next
      }
      if (parent.startsWith(scope)) search.push(parent.toLowerCase())
      for (const dependency of record.imports) {
        report.imports++
        if (isWindowsSystemLibrary(dependency.name)) continue
        const shipped = search.some(directory => byDirectory.get(directory)?.some(candidate => basename(candidate.file).toLowerCase() === dependency.name && candidate.machine === record.machine))
        if (!shipped) missing.push(`${record.file}: missing ${dependency.delay ? 'delay-loaded ' : ''}${dependency.name}`)
      }
    }
    if (missing.length) throw new Error(`Unshipped Windows dependencies:\n${missing.slice(0, 30).join('\n')}${missing.length > 30 ? `\n... ${missing.length - 30} more` : ''}`)
    report.scopes.push({ path: scope, files: records.length })
  }
  for (const input of roots) {
    const root = resolve(input), records = []
    const visit = async (directory, depth) => {
      if (depth > budget.depth) throw new Error('Windows dependency scan exceeded its directory depth limit')
      for await (const entry of await opendir(directory)) {
        if (++entries > budget.entries) throw new Error('Windows dependency scan exceeded its entry limit')
        const file = join(directory, entry.name)
        if (entry.isSymbolicLink()) throw new Error(`${file}: links are not supported in a Windows distribution scan`)
        if (entry.isDirectory()) await visit(file, depth + 1)
        else if (/\.(?:exe|dll|node|drv)$/i.test(entry.name)) records.push(await inspect(file, await lstat(file)))
      }
    }
    await visit(root, 0)
    check(root, records)
  }
  for (const input of files) {
    const file = resolve(input), metadata = await lstat(file)
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${file}: expected a standalone regular PE file`)
    // Standalone downloads have no implicit access to neighboring build outputs.
    check(file, [await inspect(file, metadata)])
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const roots = [], files = []
    for (let index = 2; index < process.argv.length; index += 2) {
      const flag = process.argv[index], path = process.argv[index + 1]
      if (!['--root', '--file'].includes(flag) || !path || path.startsWith('--')) throw new Error('Usage: windows-dependencies.mjs [--root UNPACKED_DIRECTORY] [--file STANDALONE_EXE] ...')
      ;(flag === '--root' ? roots : files).push(path)
    }
    const report = await checkWindowsDependencies({ roots, files })
    console.log(`Windows dependencies verified: ${report.files} PE files, ${report.imports} imports, ${report.scopes.length} distributions`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
