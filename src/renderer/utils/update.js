import { httpGet } from './request'
import pkg from '../../../package.json'

const repository = pkg.repository.url.replace(/^git\+https:\/\/github.com\//, '').replace(/\.git$/, '')

const address = [
  `https://raw.githubusercontent.com/${repository}/master/publish/version.json`,
  `https://cdn.jsdelivr.net/gh/${repository}@master/publish/version.json`,
]

const request = async(url, retryNum = 0) => {
  return new Promise((resolve, reject) => {
    httpGet(url, {
      timeout: 10000,
    }, (err, resp, body) => {
      if (err || resp.statusCode != 200) {
        ++retryNum >= 3
          ? reject(err || new Error(resp.statusMessage || resp.statusCode))
          : request(url, retryNum).then(resolve).catch(reject)
      } else resolve(body)
    })
  })
}

const getDirectInfo = async(url) => {
  return request(url).then(info => {
    if (info.version == null) throw new Error('failed')
    return info
  })
}

export const getVersionInfo = async(index = 0) => {
  return getDirectInfo(address[index]).catch(async(err) => {
    index++
    if (index >= address.length) throw err
    return getVersionInfo(index)
  })
}
