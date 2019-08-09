import qs from 'qs'
import PromiseThrottle from 'promise-throttle'
import SpotifyWebApi from 'spotify-web-api-node'
import Worker from './spotify-worker'

export default class Spotify {
  private readonly client!: SpotifyWebApi
  private readonly environment: string = process.env.NODE_ENV as string
  private readonly throttler!: PromiseThrottle
  private expiry: number = 0
  private refreshToken: string = ''
  private stateToken: string = ''

  constructor() {
    // Init state
    this.generateStateToken()

    // Init Promise Throttler
    this.throttler = new PromiseThrottle({
      requestsPerSecond: 5,
    })

    // Init API client
    this.client = new SpotifyWebApi({
      redirectUri: this.redirectUri,
    })
  }

  get authUri(): string {
    const API_QUERY = qs.stringify({
      client_id: 'a2d37a37164c48e48d3693491c20e7ae',
      response_type: 'code',
      redirect_uri: this.redirectUri,
      state: this.stateToken,
      scope: [
        'playlist-modify-private',
        'playlist-modify-public',
        'playlist-read-collaborative',
        'playlist-read-private',
        'ugc-image-upload',
      ].join(' '),
      show_dialog: false,
    })

    return `https://accounts.spotify.com/authorize?${API_QUERY}`
  }

  get authenticated(): boolean {
    return this.refreshToken !== '' && this.expiry !== 0
  }

  get redirectUri(): string {
    return `http${this.environment === 'production' ? 's://playman.jared.gq' : '://localhost:8080'}/callback`
  }

  /**
   * Adds a set of tracks to a playlist.
   * Recursive function (API endpoint is paginated).
   *
   * @param id - Playlist ID
   * @param tracks - List of track IDs to add to playlist
   * @param resolve - Promise resolve() to be called after all tracks have been added
   * @param reject - Promise reject() to be called in the event of a Spotify API error
   */
  public async addTracksToPlaylist(id: string, tracks: any[],
                                   resolve: (arg0: any) => void, reject: (arg0: any) => void) {
    this.reauth().then(() => {
      this.throttler.add(() => {
        return this.client.addTracksToPlaylist(id, tracks.splice(0, 100))
      }).then((response: any) => {
        const snapshotId = response.body.snapshot_id

        if (tracks.length) {
          this.addTracksToPlaylist(id, tracks, resolve, reject)
        } else {
          resolve(snapshotId)
        }
      }).catch((error: any) => reject(new Error(error)))
    })
  }

  /**
   * Changes playlist metadata and cover image.
   *
   * @param id - Playlist ID
   * @param details - New playlist metadata and cover image. All fields optional.
   */
  public async changePlaylistDetails(id: string, details: any) {
    return new Promise((resolve, reject) => {
      this.reauth().then(() => {
        // Check if there is any cover art to commit
        if (details.hasOwnProperty('art')) {
          const art = details.art.split(',')[1]
          delete details.art
          this.throttler.add(() => fetch(`https://api.spotify.com/v1/playlists/${id}/images`, {
            method: 'PUT',
            mode: 'cors',
            cache: 'no-cache',
            headers: {
              'Content-Type': 'image/jpeg',
              'Authorization': `Bearer ${this.client.getAccessToken()}`,
            },
            body: art,
          })).then(() => resolve())
            .catch((error: any) => reject(new Error(error)))
        }

        // Check if there are any details to commit
        if (Object.keys(details).length) {
          this.throttler.add(() => this.client.changePlaylistDetails(id, details))
            .then(() => resolve())
            .catch((error: any) => reject(new Error(error)))
        }
      })
    })
  }

  /**
   * Removes all tracks from a playlist.
   *
   * @param id - Playlist ID
   */
  public async deleteAllPlaylistTracks(id: string) {
    return new Promise((resolve, reject) => {
      this.reauth().then(() => {
        this.throttler.add(() => {
          return this.client.replaceTracksInPlaylist(id, [])
        }).then((response: any) => resolve(response.body.snapshot_id))
          .catch((error: any) => reject(new Error(error)))
      })
    })
  }

  /**
   * Removes a set of tracks from a playlist.
   * Recursive function (API endpoint accepts max 100 tracks per request).
   *
   * @param id - Playlist ID
   * @param snapshot - Playlist snapshot ID
   * @param tracks - Playlist tracks
   * @param resolve - Promise resolve() to be called after tracks have been removed
   * @param reject - Promise reject() to be called in the event of a Spotify API error
   */
  public async deletePlaylistTracks(id: string, snapshot: string, tracks: any[],
                                    resolve: (arg0: any) => void, reject: (arg0: any) => void) {
    this.reauth().then(() => {
      this.throttler.add(() => {
        return this.client.removeTracksFromPlaylistByPosition(id, tracks.splice(0, 100), snapshot)
      }).then((response: any) => {
        const snapshotId = response.body.snapshot_id

        if (tracks.length) {
          this.deletePlaylistTracks(id, snapshotId, tracks, resolve, reject)
        } else {
          resolve(snapshotId)
        }
      })
        .catch((error: any) => reject(new Error(error)))
    })
  }

  /**
   * Exports a playlist's tracks as CSV data to be downloaded by the user.
   *
   * @param name - Playlist name
   * @param tracks - Playlist tracks
   */
  public async exportPlaylist(name: string, tracks: any) {
    return new Promise((resolve, reject) => {
      Worker.send({type: 'csv_encode_tracks', data: {name, tracks}})
      .then((exported: any) => resolve(exported))
      .catch((error: any) => reject(new Error(error)))
    })
  }

  /**
   * Exports multiple playlists as CSV files in a ZIP to be downloaded by the user.
   * Recursive function (API endpoint is paginated).
   *
   * @param username - Username of currently logged in user (used in filename)
   * @param ids - List of playlist IDs to back up
   * @param retrieved - Initial list to feed the recursive function with
   * @param resolve - Promise resolve() to be called after all playlists have been exported
   * @param reject - Promise reject() to be called in the event of a Spotify API error
   */
  public async exportPlaylists(username: string, ids: string[], retrieved: any[],
                               resolve: (arg0: any) => void, reject: (arg0: any) => void) {
    if (ids.length) {
      const id = ids.splice(0, 1)[0]
      this.getPlaylist(id).then((playlist: any) => {
        retrieved.push({
          name: playlist.details.name,
          id: playlist.details.id,
          tracks: playlist.tracks,
        })
        this.exportPlaylists(username, ids, retrieved, resolve, reject)
      }).catch((error: any) => reject(new Error(error)))
    } else {
      Worker.send({
        type: 'csv_encode_multiple',
        data: {
          username,
          playlists: retrieved,
        },
      }).then((exported: any) => resolve(exported))
        .catch((error: any) => reject(new Error(error)))
    }
  }

  /**
   * Retrieves details about the user currently logged in.
   */
  public async getMe() {
    return new Promise((resolve, reject) => {
      this.reauth().then(() => {
        this.throttler.add(() => this.client.getMe())
          .then((me: any) => resolve(me))
          .catch((error: any) => reject(new Error(error)))
      })
    })
  }

  /**
   * Retrieves details about a playlist.
   * Returns details along with the playlist's tracks, retrieved by this.getPlaylistTracks().
   *
   * @param id - Playlist ID
   */
  public async getPlaylist(id: string) {
    return new Promise((resolve, reject) => {
      this.reauth().then(() => {
        this.throttler.add(() => this.client.getPlaylist(id))
          .then((response: any) => {
            new Promise((resolve1, reject1) => {
              return this.getPlaylistTracks(id, [], 0, resolve1, reject1)
            }).then((tracks: any) => {
              const { body } = response
              resolve({
                details: {
                  art: body.images,
                  name: body.name,
                  desc: body.description,
                  id,
                  isCollab: body.collaborative,
                  isPublic: body.public === true,
                  snapshot: body.snapshot_id,
                },
                tracks,
              })
            }).catch((error: any) => reject(new Error(error)))
          }).catch((error: any) => reject(new Error(error)))
      })
    })
  }

  /**
   * Gets a list of playlists that the current user owns.
   * Recursive function (API endpoint is paginated).
   *
   * @param username - Username of currently logged in user
   * @param initial - Initial list to feed the recursive function with
   * @param resolve - Promise resolve() to be called after all playlists have been retrieved
   * @param reject - Promise reject() to be called in the event of a Spotify API error
   */
  public async getUserPlaylists(username: string, initial: any[],
                                resolve: (arg0: any) => void, reject: (arg0: any) => void) {
    this.reauth().then(() => {
      this.throttler.add(() => this.client.getUserPlaylists())
        .then((response: any) => {
          const playlists = initial.concat(response.body.items)

          // Check if we have everything
          if (response.body.next === null) {
            // We have everything! Now let's filter the results to playlists that the user owns
            Worker.send({
              type: 'filter_user_playlists',
              data: {
                playlists,
                username,
              },
            }).then((results) => resolve(results))
          } else {
            // Retrieve next page
            this.getUserPlaylists(username, playlists, resolve, reject)
          }
        }).catch((error: any) => reject(new Error(error)))
    })
  }

  /**
   * Removes a set of tracks from a playlist, consolidates them,
   * and reinserts them as one continuous set at a specified point in the playlist.
   *
   * @param id - Playlist ID
   * @param snapshot - Playlist snapshot ID (necessary for emptying current playlist; see comments in function)
   * @param tracks - Playlist tracks
   * @param tracksToReorder - Playlist track *indices* to reorder
   * @param placeTracksAfter - Playlist track *index* after which tracksToReorder will be inserted
   */
  public async reorderPlaylistTracks(id: string, snapshot: string, tracks: any[],
                                     tracksToReorder: number[], placeTracksAfter: number) {
    return new Promise((resolve, reject) => {
      // We can only add 100 tracks to the replace endpoint per request,
      // which means that it would be better to just delete everything first
      // and add the new reordered tracks in batches of 100.
      this.deleteAllPlaylistTracks(id).then(() => {
        // Now that the playlist is empty,
        // we can now build and send the new ordered list of tracks.
        Worker.send({
          type: 'reorder_playlist_tracks',
          data: {tracks, tracksToReorder, placeTracksAfter},
        }).then((result: any) => this.addTracksToPlaylist(id, result, resolve, reject))
      }).catch((error) => reject(new Error(error)))
    })
  }

  /**
   * Stores the authorization tokens necessary for communicating with the Spotify API.
   *
   * @param access - OAuth access token
   * @param refresh - OAuth refresh token
   * @param expiry - OAuth access token expiration (in ms since epoch)
   */
  public async setTokens(access: string, refresh: string, expiry: number) {
    return new Promise((resolve, reject) => {
      this.refreshToken = refresh
      this.expiry = expiry

      this.reauth()
        .then((result: any) => {
          if (!result.expired) {
            this.client.setAccessToken(access)
          }
          resolve(result)
        })
        .catch((error) => reject(error))
    })
  }

  /**
   * Randomizes playlist tracks using the modern Fisher-Yates shuffle algorithm.
   *
   * @param id - Playlist ID
   * @param snapshot - Playlist snapshot ID (necessary for emptying current playlist; see this.reorderPlaylistTracks())
   * @param tracks - Playlist tracks
   */
  public async shufflePlaylist(id: string, snapshot: string, tracks: any[]) {
    return new Promise((resolve, reject) => {
      // Same concept as this.reorderPlaylistTracks,
      // but instead of taking a list of tracks to move to a specified start point,
      // we completely randomize the track order.
      this.deleteAllPlaylistTracks(id).then(() => {
        Worker.send({
          type: 'shuffle_playlist_tracks',
          data: {tracks},
        }).then((result: any) => this.addTracksToPlaylist(id, result, resolve, reject))
      }).catch((error) => reject(new Error(error)))
    })
  }

  private generateStateToken() {
    const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    let result = ''

    for (let i = 0; i < 12; i++) {
      result += CHARS.charAt(Math.floor(Math.random() * CHARS.length))
    }

    this.stateToken = result
  }

  /**
   * Gets a list of tracks present in a playlist.
   * Recursive function (API endpoint is paginated).
   *
   * @param id - Playlist ID
   * @param initial - Initial list to feed the recursive function with
   * @param offset - Index of track from which to query the next 100 tracks
   * @param resolve - Promise resolve() to be called after all tracks have been retrieved
   * @param reject - Promise reject() to be called in the event of a Spotify API error
   */
  private async getPlaylistTracks(id: string, initial: any[], offset: number,
                                  resolve: (arg0: any) => void, reject: (arg0: any) => void) {
    const limit = 100

    this.reauth().then(() => {
      this.throttler.add(() => this.client.getPlaylistTracks(id, {offset, limit}))
        .then((response: any) => {
          const results = initial.concat(response.body.items)

          // Check if we have everything
          if (response.body.next === null) {
            // We have everything! Now let's simplify the received data
            // into something we can easily consume
            Worker.send({type: 'decode_playlist_tracks', data: results})
              .then((reply) => resolve(reply))
          } else {
            // Retrieve next page
            this.getPlaylistTracks(id, results, offset + limit, resolve, reject)
          }
        }).catch((error: any) => reject(new Error(error)))
    })
  }

  /**
   * Refreshes the Spotify API token.
   */
  private async reauth() {
    return new Promise((resolve, reject) => {
      if (new Date().getTime() >= this.expiry) {
        this.throttler.add(() => fetch(`/.netlify/functions/spotify-refresh-token`, {
          method: 'POST',
          cache: 'no-cache',
          headers: {'Content-Type': 'application/x-www-form-urlencoded'},
          body: `refresh_token=${this.refreshToken}`,
        })).then((response: any) => response.json())
          .then((result: any) => {
            const {access_token, expires_in} = result

            if (access_token !== undefined) {
              const expiry = (parseInt(expires_in, 10) * 1000) + new Date().getTime()
              this.client.setAccessToken(access_token)
              this.expiry = expiry
              resolve({
                expired: true,
                newExpiry: expiry,
                newToken: access_token,
              })
            } else {
              reject(new Error('Failed to authenticate'))
            }
          })
          .catch((error: any) => reject(new Error(error)))
      } else {
        // Token is still valid
        resolve({expired: false})
      }
    })
  }
}
