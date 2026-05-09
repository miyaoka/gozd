import Foundation
import Testing

@testable import GozdCore

@Suite("UTF8StreamDecoder")
struct UTF8StreamDecoderTests {
  @Test("4096 バイト境界で割れた UTF-8 を完全復元")
  func split4096() {
    let original = String(
      repeating: "あいうえお🍣 sushi 寿司🍱🍙🍡🍵 hello world\n",
      count: 200
    )
    let bytes = Array(original.utf8)
    var decoder = UTF8StreamDecoder()
    var out = ""
    var i = 0
    while i < bytes.count {
      let end = min(i + 4096, bytes.count)
      out += decoder.feed(Data(bytes[i..<end]))
      i = end
    }
    out += decoder.flush()
    #expect(out == original)
  }

  @Test("4 バイト emoji を 1+3 / 2+2 / 3+1 で分断しても復元される")
  func emojiBoundarySplit() {
    let emoji: [UInt8] = [0xF0, 0x9F, 0x8D, 0xA3]  // 🍣
    let pathological = Array(repeating: emoji, count: 100).flatMap { $0 }
    let expected = String(decoding: pathological, as: UTF8.self)

    for cut in 1...3 {
      var decoder = UTF8StreamDecoder()
      var out = decoder.feed(Data(pathological[0..<cut]))
      out += decoder.feed(Data(pathological[cut...]))
      out += decoder.flush()
      #expect(out == expected, "cut at offset \(cut)")
    }
  }

  @Test("1 バイトずつ feed しても復元される")
  func oneByteAtATime() {
    let emoji: [UInt8] = [0xF0, 0x9F, 0x8D, 0xA3]
    let pathological = Array(repeating: emoji, count: 100).flatMap { $0 }
    let expected = String(decoding: pathological, as: UTF8.self)

    var decoder = UTF8StreamDecoder()
    var out = ""
    for b in pathological {
      out += decoder.feed(Data([b]))
    }
    out += decoder.flush()
    #expect(out == expected)
  }

  @Test("ランダム分割 100 通りすべてで完全復元")
  func randomSplits() {
    let original = String(
      repeating: "あいうえお🍣 sushi 寿司🍱🍙🍡🍵 hello\n",
      count: 50
    )
    let bytes = Array(original.utf8)
    var rng = SystemRandomNumberGenerator()
    for trial in 0..<100 {
      let cutCount = Int.random(in: 1...10, using: &rng)
      var cuts = (0..<cutCount).map { _ in Int.random(in: 1..<bytes.count, using: &rng) }
      cuts.sort()
      cuts = [0] + cuts + [bytes.count]
      var decoder = UTF8StreamDecoder()
      var out = ""
      for i in 0..<(cuts.count - 1) {
        out += decoder.feed(Data(bytes[cuts[i]..<cuts[i + 1]]))
      }
      out += decoder.flush()
      #expect(out == original, "trial \(trial) cuts=\(cuts)")
    }
  }

  @Test("空 feed は空文字列を返し pending を変えない")
  func emptyFeed() {
    var decoder = UTF8StreamDecoder()
    #expect(decoder.feed(Data()) == "")
    // 不完全シーケンスを feed → 空 feed → 残り feed: 復元される
    let emoji: [UInt8] = [0xF0, 0x9F, 0x8D, 0xA3]
    var out = decoder.feed(Data(emoji[0..<2]))
    out += decoder.feed(Data())
    out += decoder.feed(Data(emoji[2...]))
    #expect(out == "🍣")
  }

  @Test("ASCII のみ入力は 1 回の feed でそのまま返る（保留なし）")
  func asciiOnly() {
    var decoder = UTF8StreamDecoder()
    let s = "hello world\n"
    #expect(decoder.feed(Data(s.utf8)) == s)
    #expect(decoder.flush() == "")
  }
}
