const params = new URLSearchParams(location.search)
const target = document.querySelector('#target')
const label = document.querySelector('#label')
const motion = document.querySelector('#motion')

if (params.get('variant') === 'changed') {
  target.classList.add('changed')
  label.textContent = 'changed state'
}

// Time-dependent visuals: two infinite CSS animations at unrelated periods, so
// an unstabilized capture lands on a different frame nearly every run.
if (params.get('motion') === 'css') {
  target.classList.add('spinning')
  target.classList.add('fading')
}

if (params.get('transform') === 'rotated') {
  target.classList.add('rotated')
}

if (params.get('__snapeye') === 'record') {
  const started = performance.now()
  const animate = () => {
    const elapsed = performance.now() - started
    motion.style.transform = `translateX(${Math.round((elapsed / 4) % 210)}px) rotate(${Math.round(elapsed / 3)}deg)`
    label.textContent = `frame ${Math.floor(elapsed / 80)}`
    requestAnimationFrame(animate)
  }
  requestAnimationFrame(animate)
}

window.__snapeyeFixtureReady = true
