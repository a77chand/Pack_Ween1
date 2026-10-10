import { useMemo, useState } from 'react'
import './App.css'

const neighborhoods = [
  {
    id: 'moonlit-maple',
    name: 'Moonlit Maple',
    vibe: 'Warm street lights, smiling neighbors, and a pumpkin-lined route.',
    score: 9,
    candy: 'Top-tier candy bars and snack packs all the way down the block.',
  },
  {
    id: 'candy-corn-court',
    name: 'Candy Corn Court',
    vibe: 'A busy but safe loop with lots of decorated porches and Halloween music.',
    score: 8,
    candy: 'Great mix of chewy candies, lollipops, and mini chocolate packs.',
  },
  {
    id: 'haunted-hollow',
    name: 'Haunted Hollow',
    vibe: 'Spooky and dramatic, packed with elaborate yard setups and family houses.',
    score: 7,
    candy: 'A fun route with a few surprise treat stops and glow-in-the-dark goodies.',
  },
  {
    id: 'pumpkin-passage',
    name: 'Pumpkin Passage',
    vibe: 'Cozy and festive, with a smooth sidewalk route for trick-or-treating.',
    score: 8,
    candy: 'Reliable treats for every house, with plenty of classic favorites.',
  },
]

const startingHouses = [
  { id: 1, name: 'Pumpkin Row', x: 18, y: 58, candyValue: 3, claimed: false },
  { id: 2, name: 'Clover Lane', x: 32, y: 49, candyValue: 4, claimed: false },
  { id: 3, name: 'Willow Crest', x: 48, y: 61, candyValue: 5, claimed: false },
  { id: 4, name: 'Moon Street', x: 63, y: 54, candyValue: 4, claimed: false },
  { id: 5, name: 'Hawk Terrace', x: 78, y: 63, candyValue: 3, claimed: false },
]

const chatMessages = [
  { user: 'WitchyWin', text: 'Clover Lane is giving out full-size candy bars tonight.' },
  { user: 'PumpkinPup', text: 'Moon Street had the best gummy snacks.' },
  { user: 'GoboGhost', text: 'The spooky haunted porch on Willow Crest is a must-stop.' },
  { user: 'CandyKid99', text: 'Our team hit five houses in under 12 minutes.' },
]

function App() {
  const [form, setForm] = useState({
    username: 'MiloMoon',
    password: '',
    neighborhood: 'Moonlit Maple',
  })
  const [view, setView] = useState('login')
  const [game, setGame] = useState({
    player: { x: 8, y: 62 },
    houses: startingHouses,
    candy: 0,
  })

  const selectedArea = useMemo(
    () =>
      neighborhoods.find((area) => area.name === form.neighborhood) ?? neighborhoods[0],
    [form.neighborhood],
  )

  const handleInputChange = (event) => {
    const { name, value } = event.target
    setForm((current) => ({ ...current, [name]: value }))
  }

  const handleLogin = (event) => {
    event.preventDefault()
    setView('preview')
  }

  const handleConfirmArea = () => {
    setView('game')
  }

  const moveStreet = () => {
    setGame((current) => {
      const nextX = Math.min(current.player.x + 9, 90)
      const nextY = 64 + Math.sin(nextX / 16) * 12

      let nextCandy = current.candy
      const nextHouses = current.houses.map((house) => {
        const distance = Math.hypot(nextX - house.x, nextY - house.y)

        if (!house.claimed && distance < 12) {
          nextCandy += house.candyValue
          return { ...house, claimed: true }
        }

        return house
      })

      return {
        player: { x: nextX, y: nextY },
        houses: nextHouses,
        candy: nextCandy,
      }
    })
  }

  const endGame = () => {
    setView('chat')
  }

  const totalPossibleCandy = game.houses.reduce((sum, house) => sum + house.candyValue, 0)
  const collectedHouses = game.houses.filter((house) => house.claimed).length
  const remainingHouses = game.houses.length - collectedHouses

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-mark">🐾</span>
          <div>
            <p className="eyebrow">Neighborhood Quest</p>
            <h1>Spooky Street</h1>
          </div>
        </div>
        <button type="button" className="ghost-button">
          Halloween Pass
        </button>
      </header>

      {view === 'login' && (
        <section className="panel auth-panel">
          <div className="hero-copy">
            <p className="eyebrow accent">Bright & spooky fun</p>
            <h2>Ready for a candy-filled night?</h2>
            <p>
              Sign in, pick your neighborhood, and let the AI scout the safest,
              sweetest route before the cat starts prowling the streets.
            </p>
            <div className="stat-row">
              <div>
                <strong>4.9/5</strong>
                <span>Kid ratings</span>
              </div>
              <div>
                <strong>12k</strong>
                <span>Candies claimed</span>
              </div>
              <div>
                <strong>9.2</strong>
                <span>Avg route score</span>
              </div>
            </div>
          </div>

          <form className="login-form" onSubmit={handleLogin}>
            <label>
              Username
              <input
                type="text"
                name="username"
                value={form.username}
                onChange={handleInputChange}
                placeholder="MiloMoon"
              />
            </label>

            <label>
              Password
              <input
                type="password"
                name="password"
                value={form.password}
                onChange={handleInputChange}
                placeholder="••••••••"
              />
            </label>

            <label>
              Neighborhood
              <select
                name="neighborhood"
                value={form.neighborhood}
                onChange={handleInputChange}
              >
                {neighborhoods.map((area) => (
                  <option key={area.id} value={area.name}>
                    {area.name}
                  </option>
                ))}
              </select>
            </label>

            <button type="submit" className="primary-button">
              Start Trick-or-Treating
            </button>
          </form>
        </section>
      )}

      {view === 'preview' && (
        <section className="panel preview-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow accent">AI route check</p>
              <h2>{selectedArea.name}</h2>
            </div>
            <div className="score-pill">{selectedArea.score}/10</div>
          </div>

          <div className="route-summary">
            <div className="summary-card">
              <span className="label">Safety</span>
              <strong>Excellent</strong>
              <small>Low traffic, well-lit streets, family homes.</small>
            </div>
            <div className="summary-card">
              <span className="label">Candy gain</span>
              <strong>High</strong>
              <small>{selectedArea.candy}</small>
            </div>
            <div className="summary-card">
              <span className="label">Walk time</span>
              <strong>24 min</strong>
              <small>Comfortable pace for young explorers.</small>
            </div>
          </div>

          <div className="neighborhood-grid">
            {neighborhoods.map((area) => (
              <button
                key={area.id}
                type="button"
                className={`neighborhood-card ${form.neighborhood === area.name ? 'selected' : ''}`}
                onClick={() => setForm((current) => ({ ...current, neighborhood: area.name }))}
              >
                <div className="mini-header">
                  <span>{area.name}</span>
                  <strong>{area.score}/10</strong>
                </div>
                <p>{area.vibe}</p>
              </button>
            ))}
          </div>

          <div className="confirm-row">
            <div>
              <p className="eyebrow">Chosen route</p>
              <h3>{form.neighborhood}</h3>
            </div>
            <button type="button" className="primary-button" onClick={handleConfirmArea}>
              Confirm neighborhood
            </button>
          </div>
        </section>
      )}

      {view === 'game' && (
        <section className="panel game-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow accent">Live route</p>
              <h2>{form.neighborhood}</h2>
            </div>
            <button type="button" className="ghost-button" onClick={endGame}>
              End session
            </button>
          </div>

          <div className="game-metrics">
            <div className="metric-box">
              <span>Candies</span>
              <strong>{game.candy}</strong>
            </div>
            <div className="metric-box">
              <span>Houses left</span>
              <strong>{remainingHouses}</strong>
            </div>
            <div className="metric-box">
              <span>AI score</span>
              <strong>{selectedArea.score}/10</strong>
            </div>
          </div>

          <div className="street-map">
            {game.houses.map((house) => (
              <div
                key={house.id}
                className={`house-node ${house.claimed ? 'claimed' : ''}`}
                style={{ left: `${house.x}%`, top: `${house.y}%` }}
              >
                <span>{house.claimed ? '🍬' : '🏠'}</span>
                <small>{house.name}</small>
              </div>
            ))}

            <div
              className="cat-player"
              style={{ left: `${game.player.x}%`, top: `${game.player.y}%` }}
            >
              <span>🐈</span>
            </div>

            <div className="street-path" />
          </div>

          <div className="game-actions">
            <button type="button" className="primary-button" onClick={moveStreet}>
              Move down the block
            </button>
            <p>
              {remainingHouses === 0
                ? 'All candy spots collected! Great job, little explorer.'
                : `${remainingHouses} sweet stops still glowing on the route.`}
            </p>
          </div>
        </section>
      )}

      {view === 'chat' && (
        <section className="panel community-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow accent">Community chat</p>
              <h2>Neighborhood buzz</h2>
            </div>
            <button type="button" className="ghost-button" onClick={() => setView('login')}>
              New mission
            </button>
          </div>

          <div className="chat-box">
            {chatMessages.map((message, index) => (
              <div key={index} className="chat-bubble">
                <span className="chat-user">{message.user}</span>
                <p>{message.text}</p>
              </div>
            ))}
          </div>

          <div className="chat-summary">
            <div>
              <span>Session total</span>
              <strong>{game.candy} candies</strong>
            </div>
            <div>
              <span>Best stop</span>
              <strong>Moon Street</strong>
            </div>
            <div>
              <span>Route rating</span>
              <strong>{selectedArea.score}/10</strong>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}

export default App
