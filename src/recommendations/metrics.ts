export function measureQueue(
  ids: readonly string[],
  artistById: ReadonlyMap<string, string | undefined>,
  recentlyPlayed: ReadonlySet<string>,
  previouslyHeard: ReadonlySet<string> = recentlyPlayed,
) {
  const artists = new Set<string>()
  let knownArtistTracks = 0
  let sameArtistTransitions = 0
  let knownArtistTransitions = 0
  let historyRepeats = 0
  let unheardTracks = 0
  let previousArtist: string | undefined

  for (const id of ids) {
    const artist = artistById.get(id)
    if (artist) {
      artists.add(artist)
      knownArtistTracks++
      if (previousArtist) {
        knownArtistTransitions++
        if (previousArtist === artist) sameArtistTransitions++
      }
    }
    if (recentlyPlayed.has(id)) historyRepeats++
    if (!previouslyHeard.has(id)) unheardTracks++
    previousArtist = artist
  }

  return {
    tracks: ids.length,
    knownArtistTracks,
    distinctArtists: artists.size,
    artistDiversity: knownArtistTracks ? artists.size / knownArtistTracks : null,
    sameArtistTransitionRate: knownArtistTransitions ? sameArtistTransitions / knownArtistTransitions : null,
    repeatedTracks: ids.length - new Set(ids).size,
    historyRepeats,
    unheardTracks,
    unheardShare: ids.length ? unheardTracks / ids.length : null,
  }
}
