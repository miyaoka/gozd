import Foundation

// PTY の read(fd, buf, 4096) は UTF-8 マルチバイト境界で割れる。
// naive な `String(data:encoding: .utf8)` は不完全シーケンスで nil を返すため、
// 末尾の不完全 UTF-8 シーケンスを次回読み込みまで保留するストリームデコーダが必要。
//
// 検証: `gozd-spike` の `UTF8StreamDecoderTest` で
//   - 4096 バイト分割
//   - 4 バイト emoji を 1+3 / 2+2 / 3+1 で分断
//   - 1 バイトずつ細切れ
//   - 100 通りのランダム分割
// すべてで完全復元を確認済み。
//
// 採用しなかった代替案:
//   - `String.Encoding.utf8` + lossy: 不完全部分が U+FFFD（置換文字）に化け、後続データと結合できない
//   - `UnicodeDecodingResult` 直接利用: API が低レベルすぎてバッファ管理が煩雑
public struct UTF8StreamDecoder: Sendable {
  private var pending: [UInt8] = []

  public init() {}

  /// バイトを feed して、確定した UTF-8 シーケンスのみを文字列として返す。
  /// 末尾に不完全なシーケンスがあれば内部に保留する。
  public mutating func feed(_ data: Data) -> String {
    if data.isEmpty && pending.isEmpty { return "" }

    var combined = pending
    combined.append(contentsOf: data)
    pending.removeAll(keepingCapacity: true)

    let safeEnd = safePrefixEnd(combined)
    let safeBytes = combined[..<safeEnd]
    pending = Array(combined[safeEnd...])

    if safeBytes.isEmpty { return "" }
    return String(decoding: safeBytes, as: UTF8.self)
  }

  /// 残った保留バイトを強制 flush（PTY exit 時用）。
  /// 不正バイトは U+FFFD（置換文字）に化ける。
  public mutating func flush() -> String {
    if pending.isEmpty { return "" }
    let s = String(decoding: pending, as: UTF8.self)
    pending.removeAll(keepingCapacity: true)
    return s
  }

  /// `bytes[..<返値]` が完結した UTF-8 シーケンスのみで構成されるような末尾位置を返す。
  /// UTF-8 のマルチバイト最大長は 4 バイトなので、末尾から最大 3 バイトだけ走査すれば足りる。
  private func safePrefixEnd(_ bytes: [UInt8]) -> Int {
    let count = bytes.count
    var i = count
    while i > 0 && (count - i) < 4 {
      let b = bytes[i - 1]
      if b & 0x80 == 0 {
        // ASCII 単独。これより手前は完結している
        return i
      }
      if b & 0xC0 == 0xC0 {
        // リードバイト発見。期待長を計算して、足りていれば全完結、足りなければ保留
        let expected: Int
        if b & 0xE0 == 0xC0 {
          expected = 2
        } else if b & 0xF0 == 0xE0 {
          expected = 3
        } else if b & 0xF8 == 0xF0 {
          expected = 4
        } else {
          // 不正リードバイトだが落とさず通す（renderer 側で置換文字に化けて済む）
          expected = 1
        }
        let have = count - (i - 1)
        if have >= expected { return count }
        return i - 1
      }
      // continuation byte（0x80..=0xBF）。さらに手前へ
      i -= 1
    }
    return count
  }
}
