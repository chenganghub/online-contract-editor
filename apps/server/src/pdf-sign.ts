// PDF 数字签名和验签（docs/设计/08 第 5 节，t12）。
// 签：签署完成后的最终 PDF 用 PKCS#12 证书做 PKCS#7 分离签名（adbe.pkcs7.detached，Adobe Reader、福昕能验），用 @signpdf。
// 签名接口可插拔（PdfSigner）：内置的是 PKCS#12；接 CA 云证书、时间戳服务时宿主自己实现一个。没配证书时用自签的测试证书，
// 证书信息里 test 为 true，签署报告、验签结果里都标「测试证书，无法律效力」。
// 验：按 ByteRange 取签名覆盖的字节算摘要，和签名里的 messageDigest 比（内容有没有被改）；用证书公钥验签名属性（签名是不是这张证书签的）；
// 看签名覆盖的是不是整个文件（签完又追加了内容的算不完整）
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import forge from 'node-forge'
import { PDFDocument } from 'pdf-lib'
import { SignPdf } from '@signpdf/signpdf'
import { P12Signer } from '@signpdf/signer-p12'
import { pdflibAddPlaceholder } from '@signpdf/placeholder-pdf-lib'

/** 签名证书（签署报告、验签结果里显示） */
export interface CertInfo {
  subject: string
  issuer: string
  serial: string
  notBefore: string
  notAfter: string
  /** 自签的测试证书：无法律效力 */
  test: boolean
}
export interface SignMeta {
  /** 签名原因（PDF 阅读器的签名面板里显示），如「签署完成：甲方 张三、乙方 李四」 */
  reason: string
  location: string
  contactInfo: string
  signingTime: Date
}
/** 签名接口：拿到最终 PDF，返回签好的 PDF */
export interface PdfSigner {
  cert: CertInfo
  sign(pdf: Buffer, meta: SignMeta): Promise<Buffer>
}

/** 证书里的 CN（没有就用整个主题） */
const cnOf = (dn: string) => dn.split('\n').find((l) => l.startsWith('CN='))?.slice(3) ?? dn.replace(/\n/g, ', ')
function certInfoOf(der: Buffer, test: boolean): CertInfo {
  const x = new crypto.X509Certificate(der)
  return { subject: cnOf(x.subject), issuer: cnOf(x.issuer), serial: x.serialNumber, notBefore: new Date(x.validFrom).toISOString(), notAfter: new Date(x.validTo).toISOString(), test }
}
const derOf = (cert: forge.pki.Certificate) => Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary')

/** PKCS#12 证书签名（企业自有证书，或 CA 发的文件证书） */
export function p12PdfSigner(p12: Buffer, passphrase: string, test = false): PdfSigner {
  const parsed = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.createBuffer(p12.toString('binary'))), false, passphrase)
  const certs = parsed.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []
  const keys = parsed.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []
  const key = keys[0]?.key as forge.pki.rsa.PrivateKey | undefined
  // 和私钥配对的那张是签名证书（其余是证书链）
  const own = certs.find((b) => {
    const pub = b.cert?.publicKey as forge.pki.rsa.PublicKey | undefined
    return key && pub && pub.n.compareTo(key.n) === 0 && pub.e.compareTo(key.e) === 0
  })?.cert
  if (!key || !own) throw new Error('PKCS#12 证书里没有配对的私钥和证书')
  const cert = certInfoOf(derOf(own), test)
  return {
    cert,
    async sign(pdf, meta) {
      const doc = await PDFDocument.load(pdf)
      // 不画签名框（签名区里是手写签名图片）；PDF 阅读器的签名面板里能看到这个签名
      pdflibAddPlaceholder({ pdfDoc: doc, reason: meta.reason, name: cert.subject, location: meta.location, contactInfo: meta.contactInfo, signingTime: meta.signingTime, appName: '在线合同编辑器' })
      // 签名字典不能放进对象流（@signpdf 要在文件里直接找到 ByteRange 和 Contents）
      const prepared = Buffer.from(await doc.save({ useObjectStreams: false }))
      return new SignPdf().sign(prepared, new P12Signer(p12, { passphrase }), meta.signingTime)
    },
  }
}

const TEST_SUBJECT = [
  { name: 'commonName', value: '在线合同编辑器测试证书（无法律效力）' },
  { name: 'organizationName', value: 'Online Contract Editor TEST' },
  { name: 'countryName', value: 'CN' },
]
/**
 * 开发、演示用的自签测试证书：存在 dir 下（同一个存储目录重启后还用同一张），没有就生成一张（RSA 2048，一年）。
 * 私钥用 Node 的 crypto 生成（快），证书和 PKCS#12 用 node-forge 拼
 */
export async function testPdfSigner(dir: string): Promise<PdfSigner> {
  const file = path.join(dir, 'test-signing.p12')
  const passphrase = 'test-only'
  const existing = await fs.readFile(file).catch(() => null)
  if (existing) return p12PdfSigner(existing, passphrase, true)
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const key = forge.pki.privateKeyFromPem(privateKey.export({ type: 'pkcs1', format: 'pem' }) as string) as forge.pki.rsa.PrivateKey
  const cert = forge.pki.createCertificate()
  cert.publicKey = forge.pki.setRsaPublicKey(key.n, key.e)
  // 序列号要是正数：最高位不能是 1
  cert.serialNumber = `01${crypto.randomBytes(8).toString('hex')}`
  cert.validity.notBefore = new Date(Date.now() - 60_000)
  cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000)
  // 中文要按 UTF8String 写（node-forge 默认按 PrintableString，写不了中文；标成 UTF8 时它自己转码）
  const subject = TEST_SUBJECT.map((a) => ({ ...a, valueTagClass: forge.asn1.Type.UTF8 as number }))
  cert.setSubject(subject)
  cert.setIssuer(subject)
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
  ])
  cert.sign(key, forge.md.sha256.create())
  const p12 = Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(key, [cert], passphrase, { algorithm: '3des' })).getBytes(), 'binary')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(file, p12, { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'EEXIST') throw e
  })
  // 几个进程同时生成时以先写进去的那张为准
  return p12PdfSigner(await fs.readFile(file), passphrase, true)
}

/** 一个签名的核对结果 */
export interface SignatureCheck {
  /** 签名覆盖的内容没被改过，签名值也对得上证书 */
  valid: boolean
  /** 签名覆盖到文件末尾（签完以后没有再追加修改） */
  coversWholeFile: boolean
  signedAt: string | null
  reason: string | null
  cert: (Omit<CertInfo, 'test'> & { selfSigned: boolean }) | null
  /** 没通过时为什么 */
  error?: string
}
export interface PdfVerifyResult {
  sha256: string
  signatures: SignatureCheck[]
}

/** PDF 字符串：<FEFF...> 是 UTF-16BE，(...) 是普通字符串 */
function pdfText(raw: string | undefined): string | null {
  if (!raw) return null
  if (raw.startsWith('<')) {
    const hex = raw.slice(1, -1).replace(/\s/g, '')
    const bytes = Buffer.from(hex, 'hex')
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      const swapped = Buffer.from(bytes.subarray(2))
      swapped.swap16()
      return swapped.toString('utf16le')
    }
    return bytes.toString('latin1')
  }
  return raw.slice(1, -1).replace(/\\([()\\])/g, '$1')
}
/** 签名属性里某一项的值（ASN.1 节点） */
const attrOf = (attrs: forge.asn1.Asn1[], oid: string) => {
  const a = attrs.find((x) => forge.asn1.derToOid((x.value as forge.asn1.Asn1[])[0]!.value as string) === oid)
  return a ? ((a.value as forge.asn1.Asn1[])[1]!.value as forge.asn1.Asn1[])[0] : undefined
}

/** 核对 PDF 里的每个数字签名 */
export function verifyPdf(pdf: Buffer): PdfVerifyResult {
  const sha256 = crypto.createHash('sha256').update(pdf).digest('hex')
  const text = pdf.toString('latin1')
  const signatures: SignatureCheck[] = []
  for (const m of text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)) {
    const [a, b, c, d] = m.slice(1, 5).map(Number) as [number, number, number, number]
    const dict = text.slice(Math.max(0, m.index - 2000), Math.min(text.length, c + 2000))
    const field = (name: string) => pdfText(dict.match(new RegExp(`/${name}\\s*(\\((?:\\\\.|[^\\\\)])*\\)|<[0-9A-Fa-f\\s]*>)`))?.[1])
    const base = { coversWholeFile: a === 0 && c + d === pdf.length, reason: field('Reason'), signedAt: null as string | null, cert: null as SignatureCheck['cert'] }
    try {
      if (a + b > c || c + d > pdf.length) throw new Error('ByteRange 超出文件')
      const hex = text.slice(a + b, c).replace(/^</, '').replace(/>$/, '').replace(/\s/g, '')
      // 签名后面补的是 0，按 DER 自己的长度读，不管后面的
      let p7: forge.pkcs7.PkcsSignedData & { rawCapture: { authenticatedAttributes: forge.asn1.Asn1[]; signature: string; digestAlgorithm: string; serial?: string } }
      try {
        // node-forge 1.3 起 fromDer 收选项（@types/node-forge 还是旧的 strict 布尔参数）
        const fromDer = forge.asn1.fromDer as unknown as (b: forge.util.ByteStringBuffer, o: { parseAllBytes: boolean }) => forge.asn1.Asn1
        const asn1 = fromDer(forge.util.createBuffer(Buffer.from(hex, 'hex').toString('binary')), { parseAllBytes: false })
        p7 = forge.pkcs7.messageFromAsn1(asn1) as typeof p7
      } catch (e) {
        throw new Error(`签名数据损坏（${e instanceof Error ? e.message : String(e)}）`)
      }
      const raw = p7.rawCapture
      const cert = p7.certificates.find((x) => !raw.serial || x.serialNumber === forge.util.bytesToHex(raw.serial)) ?? p7.certificates[0]
      if (!cert) throw new Error('签名里没有证书')
      const der = derOf(cert)
      const x509 = new crypto.X509Certificate(der)
      const info = certInfoOf(der, false)
      // 自签：颁发者就是自己，用自己的公钥验得过（checkIssued 还要求证书能签证书，测试证书不能，所以不用它）
      base.cert = { subject: info.subject, issuer: info.issuer, serial: info.serial, notBefore: info.notBefore, notAfter: info.notAfter, selfSigned: x509.subject === x509.issuer && x509.verify(x509.publicKey) }
      const time = attrOf(raw.authenticatedAttributes, forge.pki.oids.signingTime!)
      if (time) base.signedAt = forge.asn1.utcTimeToDate(time.value as string).toISOString()
      const algo = (forge.pki.oids[forge.asn1.derToOid(raw.digestAlgorithm)] ?? 'sha256').toLowerCase()
      // 内容：签名覆盖的两段字节的摘要和签名属性里记的一样
      const digest = crypto.createHash(algo).update(pdf.subarray(a, a + b)).update(pdf.subarray(c, c + d)).digest()
      const recorded = attrOf(raw.authenticatedAttributes, forge.pki.oids.messageDigest!)
      if (!recorded || Buffer.from(recorded.value as string, 'binary').compare(digest) !== 0) throw new Error('签名之后文件内容被改过')
      // 签名值：签名属性（按 SET 编码）用证书的公钥验
      const signed = Buffer.from(forge.asn1.toDer(forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, raw.authenticatedAttributes)).getBytes(), 'binary')
      if (!crypto.verify(algo, signed, x509.publicKey, Buffer.from(raw.signature, 'binary'))) throw new Error('签名值和证书对不上')
      signatures.push({ ...base, valid: true })
    } catch (e) {
      signatures.push({ ...base, valid: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { sha256, signatures }
}
