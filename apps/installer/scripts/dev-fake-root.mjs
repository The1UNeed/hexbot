import fs from 'node:fs'
import path from 'node:path'

const marker = '.hexbot-dev-fake'
const inside = (child, parent) => child === parent || child.startsWith(`${parent}${path.sep}`)

/** Claim only new, empty, or previously marked roots before rebuilding fake files. */
export function prepareRoot(directory, realHome) {
  const root = path.resolve(directory)

  realHome = fs.realpathSync(realHome)
  const protectedDirs = [path.join(realHome, '.hexbot'), '/Applications', path.join(realHome, 'Library')]
  const check = candidate => {
    if (inside(realHome, candidate) || protectedDirs.some(dir => inside(candidate, dir))) {
      throw new Error(`Refusing to use ${root}: it overlaps your real home or Hexbot install.`)
    }
  }

  check(root)
  // Check the closest existing parent too, so a symlink cannot bypass isolation.
  let parent = root

  while (!fs.existsSync(parent)) {parent = path.dirname(parent)}
  check(path.resolve(fs.realpathSync(parent), path.relative(parent, root)))

  if (fs.existsSync(root)) {
    const entries = fs.readdirSync(root)
    const owned = entries.includes(marker) && fs.lstatSync(path.join(root, marker)).isFile()

    if (entries.length && !owned) {
      throw new Error(`Refusing to use ${root}: the directory is not empty and has no ${marker} marker. Choose an empty directory or a previous dev:fake root.`)
    }
  } else {
    fs.mkdirSync(root, { recursive: true })
  }

  if (!fs.existsSync(path.join(root, marker))) {
    fs.writeFileSync(path.join(root, marker), 'Hexbot Installer dev:fake\n', { flag: 'wx' })
  }

  return root
}
