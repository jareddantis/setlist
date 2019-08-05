import Vue from 'vue'
import Vuex from 'vuex'
import VuexPersist from 'vuex-persist'
import Spotify from './spotify'

const api = new Spotify()
const persistence = new VuexPersist({
  key: 'setlist',
  storage: window.localStorage,
  reducer: (state: any) => ({
    accessToken: state.accessToken,
    expiry: state.expiry,
    refreshToken: state.refreshToken,
    isLoggedIn: state.isLoggedIn,
    username: state.username,
    avatarUri: state.avatarUri,
  }),
})

function getInitialState(): { [key: string]: any } {
  return {
    // User auth
    accessToken: '',
    expiry: 0,
    refreshToken: '',
    isLoggedIn: false,

    // User details
    username: '',
    avatarUri: '',

    // User data
    playlists: [],

    // Playlist currently viewing
    currentPlaylist: {},
    currentPlaylistTracks: [],
    checkedTracks: [],

    // Connection status
    offline: false,
  }
}

Vue.use(Vuex)

const store = new Vuex.Store({
  plugins: [persistence.plugin],
  state: getInitialState(),
  mutations: {
    emptyCheckedTracks: (state) => state.checkedTracks = [],
    reset: (state: any) => {
      const initialState = getInitialState()
      Object.keys(initialState).forEach((key) => {
        Vue.set(state, key, initialState[key])
      })
    },
    setLoggedIn: (state: any, loginStatus) => state.isLoggedIn = loginStatus,
    setOffline: (state, offline) => state.offline = offline,
    setPlaylist: (state, playlist) => state.currentPlaylist = Object.assign({}, state.currentPlaylist, playlist),
    setPlaylists: (state, playlists) => state.playlists = playlists,
    setPlaylistTracks: (state, tracks) => state.currentPlaylistTracks = tracks,
    setTokens: (state, authData) => Object.assign(state, authData),
    setTrackChecked: (state, { index, isChecked }) => {
      state.currentPlaylistTracks[index].checked = isChecked
      if (isChecked) {
        state.checkedTracks.push(index)
      } else {
        state.checkedTracks.splice(state.checkedTracks.indexOf(index), 1)
      }
    },
    setUserAvatar: (state, uri) => state.avatarUri = uri,
    setUsername: (state, username) => state.username = username,
  },
  getters: {
    isLoggedIn: (state: any) => state.isLoggedIn,
    authUri: () => api.authUri,
    redirectUri: () => api.redirectUri,
  },
  actions: {
    async authenticate({state, commit, dispatch}) {
      return new Promise((resolve, reject) => {
        if (!api.authenticated) {
          const {accessToken, refreshToken, expiry} = state as any

          if (accessToken === '' || refreshToken === '' || expiry === 0) {
            reject(new Error('Not authenticated'))
          } else {
            api.setTokens(accessToken, refreshToken, expiry)
              .then((results: any) => {
                if (results.expired) {
                  // Store new token and expiry
                  commit('setTokens', {
                    accessToken: results.newToken,
                    expiry: results.newExpiry,
                  })
                  commit('setLoggedIn', true)
                }
              })
              .then(() => dispatch('updateUserMeta'))
              .then(() => resolve())
              .catch((error) => reject(new Error(error)))
          }
        } else {
          // Already authenticated
          commit('setLoggedIn', true)
          resolve()
        }
      })
    },
    async changePlaylistDetails({ state }, details) {
      return new Promise((resolve, reject) => {
        api.changePlaylistDetails(state.currentPlaylist.id, details)
          .then(() => resolve())
          .catch((error: any) => reject(error))
      })
    },
    async deletePlaylistTracks({state, commit}) {
      return new Promise((resolve, reject) => {
        const { checkedTracks, currentPlaylistTracks } = state
        const { id, snapshot } = state.currentPlaylist

        if (checkedTracks.length === currentPlaylistTracks.length) {
          commit('setPlaylistTracks', [])
          api.deleteAllPlaylistTracks(id)
            .then(() => resolve())
            .catch((error) => reject(error))
        } else {
          commit('setPlaylistTracks', currentPlaylistTracks.filter((track: any) => {
            return !currentPlaylistTracks.includes(track.index)
          }))
          api.deletePlaylistTracks(id, currentPlaylistTracks, snapshot, resolve, reject)
        }

        commit('emptyCheckedTracks')
      })
    },
    async getPlaylist({state, commit}, id) {
      return api.getPlaylist(id).then((playlist: any) => {
        commit('setPlaylist', playlist.details)
        commit('setPlaylistTracks', playlist.tracks)
      })
    },
    async reorderPlaylistTracks({state}, placeTracksAfter) {
      const { checkedTracks, currentPlaylistTracks } = state
      const { id, snapshot } = state.currentPlaylist
      return api.reorderPlaylistTracks(id, snapshot, currentPlaylistTracks, checkedTracks, placeTracksAfter)
    },
    async shufflePlaylist({state}) {
      const { id, snapshot } = state.currentPlaylist
      return api.shufflePlaylist(id, snapshot, state.currentPlaylistTracks)
    },
    async updatePlaylists({state}) {
      return new Promise((resolve, reject) => {
        api.getUserPlaylists(state.username, [], resolve, reject)
      })
    },
    async updateUserMeta({commit}) {
      return new Promise((resolve, reject) => {
        // Store user avatar and username
        api.getMe().then((response: any) => {
          const result = response.body as any
          commit('setUserAvatar', result.images[0].url)
          commit('setUsername', result.id)
          resolve()
        }).catch((error) => reject(new Error(error)))
      })
    },
  },
})

export default store
