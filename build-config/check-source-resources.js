const fs = require('node:fs')
const path = require('node:path')

// App/runtime JavaScript is necessary. Reject custom source payloads and resource folders.
function checkSourceResources(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (/^(sources|builtin-sources)$/i.test(entry.name)) throw new Error(`Unexpected source resources: ${file}`)
      checkSourceResources(file)
    } else if (/\.(js|json|ts)$/i.test(entry.name)) {
      const text = fs.readFileSync(file, 'utf8')
      if (/@name\s+[^\r\n]+/.test(text) && /(?:globalThis\.lx|EVENT_NAMES\.request)/.test(text)) {
        throw new Error(`Custom source script found in distribution: ${file}`)
      }
    }
  }
}
checkSourceResources.checkArchive = archive => {
  const asar = require('@electron/asar')
  for (const file of asar.listPackage(archive)) {
    const relative = file.replace(/^[/\\]+/, '')
    if (/(?:^|[/\\])sources[/\\]/i.test(relative)) throw new Error(`Source resource in archive: ${file}`)
    if (!/\.(?:js|json)$/i.test(relative)) continue
    const text = asar.extractFile(archive, relative).toString('utf8')
    if (/@name\s+[^\r\n]+/.test(text) && /(?:globalThis\.lx|EVENT_NAMES\.request)/.test(text)) {
      throw new Error(`Custom source in archive: ${file}`)
    }
  }
}
module.exports = checkSourceResources
if (require.main === module) checkSourceResources(process.argv[2] || 'dist')
