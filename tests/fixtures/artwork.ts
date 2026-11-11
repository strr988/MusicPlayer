function syncSafe(value: number): Buffer {
  return Buffer.from([value >>> 21, value >>> 14, value >>> 7, value].map(byte => byte & 0x7f))
}

function id3Frame(id: string, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(id), syncSafe(data.length), Buffer.alloc(2), data])
}

export function mp3WithArtwork(audio: Buffer, image: Buffer, mime = 'image/jpeg'): Buffer {
  const originalTagSize = audio.subarray(6, 10).reduce((size, byte) => size * 128 + byte, 0)
  const artist = id3Frame('TPE1', Buffer.from('\x03Тестовый исполнитель\x00'))
  const title = id3Frame('TIT2', Buffer.from('\x03Test Tone MP3\x00'))
  const album = id3Frame('TALB', Buffer.from('\x03Fixture Album\x00'))
  const cover = id3Frame('APIC', Buffer.concat([Buffer.from(`\x00${mime}\x00\x03\x00`), image]))
  const tag = Buffer.concat([title, artist, album, cover])
  return Buffer.concat([audio.subarray(0, 6), syncSafe(tag.length), tag, audio.subarray(10 + originalTagSize)])
}

export function flacWithArtwork(audio: Buffer, image: Buffer): Buffer {
  const mime = Buffer.from('image/png')
  const picture = Buffer.alloc(32 + mime.length)
  picture.writeUInt32BE(3, 0) // Front cover
  picture.writeUInt32BE(mime.length, 4)
  mime.copy(picture, 8)
  picture.writeUInt32BE(12, 12 + mime.length)
  picture.writeUInt32BE(12, 16 + mime.length)
  picture.writeUInt32BE(24, 20 + mime.length)
  picture.writeUInt32BE(image.length, 28 + mime.length)
  const header = Buffer.alloc(4)
  header[0] = 6 // PICTURE
  header.writeUIntBE(picture.length + image.length, 1, 3)
  const streamInfoEnd = 8 + audio.readUIntBE(5, 3)
  return Buffer.concat([audio.subarray(0, streamInfoEnd), header, picture, image, audio.subarray(streamInfoEnd)])
}
