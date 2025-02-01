const EFFECTS = {
  CLEAR_BUFFS: 'clear_buffs',
  CLEAR_EXCREMENT: 'clear_excrement',
  DEATH_IN: 'death_in',
  DOOMSDAY_DEVICE_RESISTANCE_FOR: 'doomsday_device_resistance_for',
  DOOMSDAY_DEVICE_RESISTANT: 'doomsday_device_resistant',
  EVOLUTION_OFFSET: 'evolution_offset',
  EXCREMENTABLE_PERCENTAGE: 'excrementable_percentage',
  HEALTH_INCREMENT: 'health_increment',
  IMMEDIATE_DEATH_PERCENTAGE: 'immediate_death_percentage',
  IMMEDIATE_EVOLVE_PERCENTAGE: 'immediate_evolve_percentage',
  IMMEDIATE_EXCREMENT_PERCENTAGE: 'immediate_excrement_percentage',
  REGENERATE_TYPE: 'regenerate_type',
  STATE_BASED_EFFECT: 'states',
};

const HISTORY_EVENTS = {
  DEATH: 'death',
  DEATH_DURING_IMMORTAL_EVOLUTION: 'death_during_immortal_evolution',
  DEVOLUTION: 'devolution',
  DOOMSDAY_DEVICE_EXPLODED: 'doomsday_device_exploded',
  DOOMSDAY_DEVICE_TRIGGERED: 'doomsday_device_triggered',
  EVOLUTION: 'evolution',
  EXCREMENT: 'excrement',
  START: 'start',
  TYPE_CHANGE: 'type_change',
};

const MAX_UNIQUE_SPEECH_LOOKUP_ATTEMPTS = 16;
const TRANSLATION_REGEX = /\{([^}]*)\}/;
export const PIZZA_PET_STATES = {};

export class PizzaPet {
  _behavior;
  _blocksUntilNextState;
  _buffs;
  _configuration;
  _doomsdayDeviceId;
  _graveMessage;
  _history;
  _itemKeyLength;
  _itemRegex;
  _limits;
  _speech;
  _stateIndex;
  _startBlock;
  _type;
  blockInProgress;
  initialize;
  counter;
  blockHeight;
  doomsdayDeviceDetonatdMapping;
  doomsdayDeviceResistanceRange;
  excrement;
  excrementAt;
  hash;
  health;
  immediateEffects;
  info;
  inscriptionId;
  music;
  ordClient;
  processedChildren;
  triggeredDoomsdayDevices;
  startBlockOffsetLimit = 10;

  defaultLayerKey = 'default';

  static CONFIG_SAT = '186168751795259';

  constructor(inscriptionId, ordClient) {
    this.inscriptionId = inscriptionId;
    this.ordClient     = ordClient;
    this.initialize    = this.init();
  }

  async init() {
    this.hash          = await this.hashFor(this.inscriptionId);
    const configId     = await this.ordClient.getLatestInscriptionIdForSat(this.constructor.CONFIG_SAT);
    this.configuration = await this.ordClient.fetchJsonFor(configId);
  }

  async updateInscriptionId(inscriptionId) {
    this.inscriptionId = inscriptionId;
    this.hash = await this.hashFor(this.inscriptionId);
    this.blockHeight = undefined;
  }

  async canUpdate() {
    return this.blockHeight !== await this.ordClient.getBlockHeight();
  }

  async update() {
    await this.initialize;
    const blockHeight = await this.ordClient.getBlockHeight();
    if (blockHeight === this.blockHeight) { return; }

    this.blockHeight = blockHeight;
    this.reset();
    this.stateIndex = 0;
    this.health = this.hearts;

    const promises = [ this.getChildInscriptionMapping(), this.getDoomsdayDeviceMapping()];
    const [ children, doomsdayDevices ] = await Promise.all(promises);
    this.children = children;
    this.doomsdayDevices = doomsdayDevices;

    await this.processHistory();
    this.music = this.currentMusic();
  }

  reset() {
    this._behavior = undefined;
    this._buffs = [];
    this._doomsdayDeviceId = undefined;
    this._history = [];
    this._limits = undefined;
    this._speech = undefined;
    this._type = undefined;
    this._startBlock = undefined;
    this.sfxLoaded = [];
    this.counter = undefined;
    this.deathAt = undefined;
    this.doomsdayDeviceDetonatedAt = undefined;
    this.doomsdayDeviceResistanceRange = undefined;
    this.excrement = 0;
    this.excrementAt = [];
    this.immediateEffects = {
      excrement: false,
      evolution: false,
      death: false,
    };
    this.music = undefined;
    this.triggeredDoomsdayDevices = [];
  }

  isAlive() {
    return this.elapsedBlocks() < this.behavior.health_decrement_at || this.health > 0;
  }

  get hearts() {
    return this.configuration.hearts[this.stateIndex];
  }

  promiseResult() {
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });

    return {
      promise,
      resolve,
      _reject: reject,
    };
  }

  get history() {
    return [...this._history];
  }

  get stateIndex() {
    return this._stateIndex;
  }

  set stateIndex(value) {
    if (value < 0) { value = 0; }
    const max = this.evolutionStates.length - 1;
    if (value > max) { value = max; }

    if (value === 0 && this._history.length === 0) {
      this.addHistoryEventFor(this.startBlock, HISTORY_EVENTS.START, { type: this.type });
    } else if (this._stateIndex < value) {
      this.addHistoryEventFor(this.absoluteBlockInProgress, HISTORY_EVENTS.EVOLUTION, { previous_state: this.stateNameFor(this._stateIndex), state: this.stateNameFor(value) });
    } else if (this._stateIndex > value) {
      this.addHistoryEventFor(this.absoluteBlockInProgress, HISTORY_EVENTS.DEVOLUTION, { previous_state: this.stateNameFor(this._stateIndex), state: this.stateNameFor(value) });
    }

    this._stateIndex = value;
    this._blocksUntilNextState = this.behavior.evolution_at[this.stateIndex];

    Object.keys(this.stateBehavior || {}).forEach((key) => {
      this.behavior[key] = this.stateBehavior[key];
    });

    if (value === max) { this.clearBuffs(); }
  }

  get startBlock() {
    if (!this._startBlock) {
      const number = this.decimalForHash(this.hash, { skipWrap: true });
      const offset = number % this.startBlockOffsetLimit;
      this._startBlock = this.configuration.start + offset;
    }
    return this._startBlock;
  }

  get doomsdayDeviceId() {
    if (!this._doomsdayDeviceId) {
      const deviceIds = Object.keys(this.configuration.doomsday_devices.mapping);
      let number = this.decimalForHash(this.hash, { counter: 0 });
      let difficulty = this.decimalForHash(this.hash, { counter: 1 }) % this.configuration.doomsday_devices.difficulty;
      if (difficulty <= this.configuration.doomsday_devices.limit) {
        this._doomsdayDeviceId = -1;
      } else {
        this._doomsdayDeviceId = deviceIds[number % deviceIds.length];
      }
    }

    return this._doomsdayDeviceId === -1 ? null : this._doomsdayDeviceId;
  }

  get weakness() {
    return this.configuration.doomsday_devices.mapping[this.doomsdayDeviceId]?.name;
  }

  async getChildInscriptionMapping() {
    return this.getChildInscriptionMappingFor(this.inscriptionId);
  }

  async getChildInscriptionMappingFor(inscriptionId) {
    let mapping = {};
    let page = 0;
    let response;

    do {
      response = await this.ordClient.getChildrenInscriptionsFor(inscriptionId, { page });
      const childrenIndexedByHeight = await this.childrenIndexedByHeightFor(response);
      mapping = { ...mapping, ...childrenIndexedByHeight };
      page += 1;
    } while(response.more)

    return mapping;
  }

  getDoomsdayDeviceMapping() {
    let resolve;
    const promise = new Promise((res, _rej) => {
      resolve = res;
    });
    const devices = { triggeredAt: {}, explodesAt: {} };
    const promises = [];
    const triggerableAt = {};
    const doomsdayDeviceIds = Object.keys(this.configuration.doomsday_devices.mapping);

    doomsdayDeviceIds.forEach(async (doomsdayDeviceId) => {
      const promise = this.getChildInscriptionMappingFor(doomsdayDeviceId);
      promises.push(promise);

      const mapping = await promise;
      const coolDownBlocks = this.coolDownBlocksFor(doomsdayDeviceId);
      const triggerHeights = Object.keys(mapping).filter(height => mapping[height]?.length);

      triggerHeights.forEach((height) => {
        height = Number(height);
        devices.triggeredAt[height] = devices.triggeredAt[height] || [];
        if ((triggerableAt[doomsdayDeviceId] || 0) < height) {
          devices.triggeredAt[height].push(doomsdayDeviceId);
          const explodesAt = height + this.configuration.doomsday_devices.delay;
          devices.explodesAt[explodesAt] = devices.explodesAt[explodesAt] || [];
          devices.explodesAt[explodesAt].push(doomsdayDeviceId);
          triggerableAt[doomsdayDeviceId] = explodesAt + coolDownBlocks;
        }
      });
    });

    Promise.all(promises).then(() => resolve(devices));
    return promise;
  }

  coolDownBlocksFor(doomsdayDeviceId) {
    return this.configuration.doomsday_devices.mapping[doomsdayDeviceId]?.cool_down_blocks || 0;
  }

  childrenIndexedByHeightFor(response) {
    let resolve;
    const promise = new Promise((res, _rej) => {
      resolve = res;
    });

    const mapping = {};
    const promises = response.children.map(async (child, index) => {
      const hashedId = await this.hashFor(child.id + child.timestamp + this.hash);
      return { index, hashedId, ...child };
    });

    Promise.all(promises).then((results) => {
      results.sort((a, b) => a.index - b.index);
      results.forEach((child) => {
        mapping[child.height] = mapping[child.height] || [];
        mapping[child.height].push(child);
      });
      resolve(mapping);
    });

    return promise;
  }

  processTriggeredDoomsdayDevicesFor(block) {
    (this.doomsdayDevices.triggeredAt[block] || []).forEach((triggeredDoomsdayDeviceId) => {
      const { name } = this.configuration.doomsday_devices.mapping[triggeredDoomsdayDeviceId];
      const deviceInfo = { id: triggeredDoomsdayDeviceId, name };
      this.addHistoryEventFor(block, HISTORY_EVENTS.DOOMSDAY_DEVICE_TRIGGERED, deviceInfo);

      const existing = this.triggeredDoomsdayDevices.find(device => device.id === triggeredDoomsdayDeviceId);
      if (!existing) {
        this.triggeredDoomsdayDevices.push({ ...deviceInfo, explodedAt: null });
      }
    });
  }

  processExplodedDoomsdayDevicesFor(block) {
    let affectedByDoomsdayDevice = false;
    (this.doomsdayDevices.explodesAt[block] || []).forEach((explodedDoomsdayDeviceId) => {
      const triggered = this.triggeredDoomsdayDevices.find(deviceInfo => deviceInfo.id === explodedDoomsdayDeviceId);
      triggered.explodedAt = block;
      const { name } = this.configuration.doomsday_devices.mapping[explodedDoomsdayDeviceId];
      this.addHistoryEventFor(block, HISTORY_EVENTS.DOOMSDAY_DEVICE_EXPLODED, { id: explodedDoomsdayDeviceId, name });
      if (!affectedByDoomsdayDevice) {
        affectedByDoomsdayDevice = this.affectedByDoomsdayDevice(explodedDoomsdayDeviceId, block);
      }
    });
    return affectedByDoomsdayDevice;
  }

  performDoomsdayDeviceCoolDownFor(block) {
    this.triggeredDoomsdayDevices = this.triggeredDoomsdayDevices.filter((triggered) => {
      return !triggered.explodedAt || block < triggered.explodedAt + this.coolDownBlocksFor(triggered.id)
    });
  }

  async processHistory() {
    this.counter = 1;

    let block;
    for (let i = 1, length = this.elapsedBlocks(); i <= length; i++) {
      this.blockInProgress = i;
      block = this.absoluteBlockInProgress;

      this.decrementBlocksUntilNextState();
      const blocksUntilNextState = this.blocksUntilNextState;

      this.removeExpiredBuffs();
      if (i >= this.behavior.health_decrement_at) {
        this.processChildren(this.children[block] || []);
      }

      this.performDoomsdayDeviceCoolDownFor(block);
      this.processTriggeredDoomsdayDevicesFor(block);
      const affectedByDoomsdayDevice = this.processExplodedDoomsdayDevicesFor(block);

      if (!this.isInDeathFixupRange(block)) {
        if (this.immediateEffects.death || this.deathAt === block || affectedByDoomsdayDevice) {
          this.health = 0;
          break;
        }
      }

      if (!this.isFinalState() && (this.immediateEffects.evolve || blocksUntilNextState === 0)) {
        this.immediateEffects.evolve = false;
        this.stateIndex += 1;
      }

      if (this.shouldCreateExcrementAt(block)) {
        if (this.immediateEffects.excrement) {
          this.immediateEffects.excrement = false;
        } else {
          this.excrementAt.shift();
        }
        this.excrement += 1;
        this.addHistoryEventFor(block, HISTORY_EVENTS.EXCREMENT);
      }

      if (!this.isInDeathFixupRange(block)) {
        if (this.shouldDecrementHealth()) {
          if (!this.wasJustFed()) {
            this.decrementHealth();
          }
          if (this.health <= 0) {
            this.health = 0;
            break;
          }
        }
      }

      if (i >= this.behavior.health_decrement_at) { this.counter += 1; }
    }

    if (!this.health && !this.isInDeathFixupRange(block)) {
      this.addHistoryForDeathEventAt(block);
    }
  }

  affectedByDoomsdayDevice(doomsdayDeviceId, block) {
    const resistant = this.isFinalState() || this.behavior[EFFECTS.DOOMSDAY_DEVICE_RESISTANT] || (block >= this.doomsdayDeviceResistanceRange?.from && block <= this.doomsdayDeviceResistanceRange?.to);
    return this.doomsdayDeviceId === doomsdayDeviceId && !resistant;
  }

  truncatedFractionFor(number) {
    return Number(String(number).slice(0, 5));
  }

  decrementHealth() {
    this.health -= this.behavior.health_decrement_amount;
    const components = this.healthComponents;
    this.health = components.whole + components.fraction;
  }

  get healthComponents() {
    const decrementAmount = this.behavior.health_decrement_amount;
    const whole = Math.floor(this.health);
    const fraction = this.health - whole;
    return {
      count: this.hearts,
      whole: whole,
      fraction: Math.floor(Math.round(fraction / decrementAmount)) * decrementAmount,
      ceil: Math.ceil(this.health),
      decrementAmount: decrementAmount,
    };
  }

  processChildren(children) {
    for (let i = 0, length = children.length; i < length; i++) {
      const child = children[i];
      this.processChild(child);
    }
  }

  itemsFor(child) {
    const maskString = child.id.slice(0, this.itemKeyLength);
    if (this.configuration.items[maskString]) {
      return [this.configuration.items[maskString]];
    }

    const intMask  = parseInt(maskString, '16');
    const items    = [];
    let mask       = 0;
    let rejectMask = 0;
    const keys     = Object.keys(this.configuration.items);

    for (let i = 0, length = keys.length; i < length; i++) {
      const strBit = keys[i];
      const intBit = parseInt(strBit, 16);
      if (intMask & intBit) {
        mask |= intBit;
        const item = this.configuration.items[strBit];
        rejectMask |= parseInt(item.rejects || '0', 16);
        if (rejectMask & mask) {
          return [];
        } else {
          items.push(item);
        }
      }
    }
    return items;
  }

  processChild(child) {
    const items = this.itemsFor(child);
    const toInvoke = [];
    for (let i = 0, length = items.length; i < length; i++) {
      const item = items[i];
      if (this.limitReachedFor(item)) { continue; }
      this.processChildItem(item, child, toInvoke);
    }
    toInvoke.forEach(invocable => invocable());
  }

  processChildItem(item, child, toInvoke) {
    this._history.push({
      description: item.description,
      emoji: item.emoji,
      height: child.height,
      id: child.id,
      key: null,
    });

    if (item.buff) {
      this._buffs = this.buffs.filter(buff => buff.emoji !== item.emoji);
      this._buffs.push({ ...item, height: child.height });
    } else if (item.effects[EFFECTS.CLEAR_BUFFS]) {
      toInvoke.push(() => this.clearBuffs());
    }

    this.processEffectsFor(item, child, toInvoke);
  }

  processEffectsFor(item, child, toInvoke) {
    const keys = Object.keys(item.effects || {});
    for (let i = 0, length = keys.length; i < length; i++) {
      let key = keys[i];
      if (key === EFFECTS.CLEAR_BUFFS) { continue; }
      const value = item.effects[key];

      if (Object.hasOwn(this.behavior, key)) {
        this.behavior[key] = item.buff ? this.valueForBuff(key) : value;
      } else {
        switch(key.toLowerCase()) {
          case EFFECTS.STATE_BASED_EFFECT:
            this.processEffectsFor({ ...item, effects: value[this.stateIndex] }, child, toInvoke);
            break
          case EFFECTS.HEALTH_INCREMENT:
            this.performEffectForHealthIncrement(value);
            break;
          case EFFECTS.EXCREMENTABLE_PERCENTAGE:
            this.performEffectForExcrementPercentage(value, child);
            break;
          case EFFECTS.CLEAR_EXCREMENT:
            this.performEffectForClearExcrement(value);
            break;
          case EFFECTS.EVOLUTION_OFFSET:
            this.performEffectForEvolutionOffset(value, toInvoke);
            break;
          case EFFECTS.DEATH_IN:
            this.performEffectForDeathIn(value, child, item.buff);
            break;
          case EFFECTS.DOOMSDAY_DEVICE_RESISTANCE_FOR:
            this.performEffectForDoomsdayDeviceResistanceFor(value, child);
            break;
          case EFFECTS.REGENERATE_TYPE:
            this.performEffectForRegenerateType(value, child);
            break;
          case EFFECTS.IMMEDIATE_EXCREMENT_PERCENTAGE:
          case EFFECTS.IMMEDIATE_DEATH_PERCENTAGE:
          case EFFECTS.IMMEDIATE_EVOLVE_PERCENTAGE:
            this.performEffectForImmediatePercentage(key, value, child);
            break;
          default:
            throw `unknown effect ${key}!`;
        }
      }
    }
  }

  get buffs() {
    return [...this._buffs];
  }

  removeExpiredBuffs() {
    this._buffs = this.buffs.filter((item) => {
      const effects = this.effectsForBuff(item);
      if (Object.hasOwn(effects, EFFECTS.DOOMSDAY_DEVICE_RESISTANCE_FOR)) {
        const expirationHeight = item.height + effects[EFFECTS.DOOMSDAY_DEVICE_RESISTANCE_FOR];
        return this.absoluteBlockInProgress < expirationHeight;
      }
      return true;
    });
  }

  clearBuffs() {
    this._buffs = this.buffs.filter((item) => {
      const effects = this.effectsForBuff(item);
      return Object.hasOwn(effects, EFFECTS.DOOMSDAY_DEVICE_RESISTANCE_FOR);
    });
    this.behavior.evolution_rate      = this.configuration.behavior.evolution_rate;
    this.behavior.excrement_rate      = this.configuration.behavior.excrement_rate;
    this.behavior.health_decline_rate = this.configuration.behavior.health_decline_rate;
    this.deathAt                      = null;
  }

  get blocksUntilNextState() {
    if ((!this.behavior.evolution_rate && this.stateIndex > 0) || this.isFinalState() || !this.isAlive()) { return -1; }
    let blocks;
    if (!this.hasGameStarted()) {
      blocks = this.startBlock - this.blockHeight;
    } else {
      blocks = this._blocksUntilNextState;
    }
    const evolutionRate = !this.behavior.evolution_rate && this.stateIndex === 0 ? 1 : this.behavior.evolution_rate;
    return Math.ceil((1 / evolutionRate) * blocks);
  }

  decrementBlocksUntilNextState() {
    this._blocksUntilNextState -= 1 * this.behavior.evolution_rate;
    if (this._blocksUntilNextState < 0) {
      this._blocksUntilNextState = 0;
    }
  }

  chanceFor(percentage, number) {
    const modded = number % 100;
    return modded >= 100 - percentage;
  }

  randomNumberFor(max, hash, options = {}) {
    const zeroAllowed = !!options.zeroAllowed;
    return (this.decimalForHash(hash) % max) || (zeroAllowed ? 0 : Math.floor(max / 2));
  }

  numberOfBlocksForhealthDecline() {
    if (!this.counter || !this.behavior.health_decline_rate) { return null; }
    let fraction = 1.0 / this.behavior.health_decline_rate;
    for (let i = 0; i < this.excrement; i++) {
      fraction /= 1.5;
    }
    return Math.ceil(this.behavior.health_decrement_interval * fraction);
  }

  get absoluteBlockInProgress() {
    return this.startBlock + this.blockInProgress;
  }

  shouldDecrementHealth() {
    if (this.blockInProgress < this.behavior.health_decrement_at || this.isFinalState()) { return false; }
    const blocks = this.numberOfBlocksForhealthDecline();
    if (blocks === null) { return false; }
    return this.counter % this.numberOfBlocksForhealthDecline() === 0;
  }

  shouldCreateExcrementAt(height) {
    if (this.immediateEffects.excrement) {
      return true;
    } else {
      return this.excrementAt[0] <= height;
    }
  }

  typeFor(number, options = {}) {
    let types = Object.keys(this.configuration.types).sort();
    if (options.without) {
      const index = types.indexOf(options.without);
      if (index !== -1) {
        types.splice(index, 1);
      }
    }
    return types[number % types.length];
  }

  get type() {
    if (!this._type) {
      const decimal = this.decimalForFragmentAt('type');
      this._type = this.typeFor(decimal);
    }
    return this._type;
  }

  get state() {
    if (!this.hasGameStarted()) { return null; }
    return this.stateNameFor(this.stateIndex);
  }

  get livingState() {
    const livingState = this.isAlive() ? 'alive' : 'dead';
    return [this.state, this.type, livingState].join('.');
  }

  get evolutionStates() {
    return this.behavior.evolution_states;
  }

  get stateBehavior() {
    return this.evolutionStates[this.stateIndex]?.effects || {};
  }

  stateNameFor(stateIndex) {
    return this.evolutionStates[stateIndex]?.name || '???';
  }

  isInitialState() {
    return this.stateIndex === 0;
  }

  isFinalState() {
    return this.stateIndex === this.evolutionStates.length - 1;
  }

  immortalBackgroundLayers() {
    const layers = [];
    this.configuration.immortal_background.forEach((group, index) => {
      const position = index <= 1 ? 0 : (index * 2) - 2;
      const fragment = this.hash.slice(position, position + 2);
      const max = group.length + (index <= 2 ? 0 : 1);
      const randomIndex = parseInt(fragment, 16) % max;
      if (group[randomIndex]) {
        layers.push(group[randomIndex]);
      }
    });
    return layers;
  }

  graveLayers() {
    const layers = {};
    const traitIndexes = this.configuration.graves.trait_indexes;
    this.configuration.graves.layers.forEach((variations, index) => {
      const trait = this.configuration.traits[traitIndexes[index]];
      const variationsLength = variations.length;
      const decimal = this.decimalForFragmentAt(trait);
      const graveIndex = decimal % variationsLength;
      let variation = variations[graveIndex];
      layers[trait] = [ variation ];
    });
    return layers;
  }

  get layers() {
    if (!this.isAlive()) { return this.graveLayers(); }

    const layers = {};
    const typeConfig = this.configuration.types[this.type];
    if (!typeConfig) { throw(`"${this.type}" not found in configuration!`); }

    const scoped = typeConfig[this.stateIndex];
    if (this.stateIndex === 0) {
      layers[this.defaultLayerKey] = [ scoped ].flat();
      return layers;
    }

   if (Array.isArray(scoped)) {
      this.configuration.traits.forEach((trait, traitIndex) => {
        const variations = scoped[traitIndex];
        if (variations) {
          const variationsLength = variations.length;
          const decimal = this.decimalForFragmentAt(trait);
          const index = decimal % variationsLength;
          layers[trait] = [ variations[index] ].flat();
        }
      });
    }
    return layers;
  }

  daysUntilNextState() {
    const blocksUntilNextState = this.blocksUntilNextState;
    if (blocksUntilNextState === -1) { return -1; }
    return Math.ceil((blocksUntilNextState * 10) / 144) / 10;
  }

  async thumbnailHash() {
    const attrs = JSON.stringify([
      this.inscriptionId,
      this.type,
      this.stateIndex,
      this.hearts,
      this.health,
      this.excrement,
      this.buffs.map((buff) => buff.emoji).sort(),
      this.daysUntilNextState(),
    ]);
    return this.hashFor(attrs);
  }

  decimalForFragmentAt(locationName) {
    const location = this.configuration.locations[locationName];
    const fragment = this.hash.slice(location.index, location.index + location.length);
    return parseInt(fragment, 16);
  }

  wrapAroundFor(string, counter) {
    const length = string.length;
    const index = counter % length;
    let sliced = string.slice(index, index + length);
    const slicedLength = sliced.length;
    if (slicedLength < length) {
      sliced += string.slice(0, length - slicedLength);
    }
    return sliced;
  }

  decimalForHash(hash, options = {}) {
    let hex;
    if (!options.skipWrap) {
      const counter = Object.hasOwn(options, 'counter') ? options.counter : this.counter;
      hex = this.wrapAroundFor(hash, counter || 0);
    } else {
      hex = hash;
    }
    return parseInt(hex.slice(0, 12), 16);
  }

  hasGameStarted() {
    return this.elapsedBlocks() >= 0;
  }

  elapsedBlocks() {
    return this.blockHeight - this.startBlock;
  }

  get pollDelay() {
    return this.configuration.poll_delay;
  }

  get behavior() {
    if (!this._behavior) {
      this._behavior = { ...this.configuration.behavior };
    }
    return this._behavior;
  }

  get limits() {
    if (!this._limits) {
      this._limits = {};
    }
    return this._limits;
  }

  txIdFor(inscriptionId) {
    return inscriptionId.slice(0, inscriptionId.indexOf('i')) || '0';
  }

  wasJustFed() {
    return this.counter === 0;
  }

  limitReachedFor(item) {
    if (!item.limit) { return false; }
    const key = item.description;
    const value = this.limits[key] || 0;
    this.limits[key] = value + 1;
    return value >= item.limit;
  }

  addHistoryEventFor(blockHeight, key, options = {}) {
    const translationKeyScope = `history.${key}`;
    const id = options.id || null;
    this._history.push({
      description: this.translate(`${translationKeyScope}.description`, options),
      emoji: this.translate(`${translationKeyScope}.emoji`),
      height: blockHeight,
      id,
      key,
    });
  }

  addHistoryForDeathEventAt(block) {
    const lastHistory = this._history[this._history.length - 1] || {};
    if (lastHistory.height === block && lastHistory.key === HISTORY_EVENTS.EVOLUTION && this.isFinalState()) {
      this._history.splice(this._history.length - 1, 1);
      this.addHistoryEventFor(block, HISTORY_EVENTS.DEATH_DURING_IMMORTAL_EVOLUTION);
    } else {
      this.addHistoryEventFor(block, HISTORY_EVENTS.DEATH);
    }
  }

  performEffectForDoomsdayDeviceResistanceFor(value, child) {
    this.doomsdayDeviceResistanceRange = { from: child.height, to: child.height + Number(value) };
  }

  performEffectForHealthIncrement(value) {
    if (String(value).toLowerCase() === 'max') {
      this.health = this.hearts;
    } else {
      value = Number(value);
      if (isNaN(value)) { throw `invalid health increment value ${value}!`; }
      this.health += value;
      if (this.health > this.hearts) {
        this.health = this.hearts;
      }
    }
    this.counter = 0;
  }

  performEffectForExcrementPercentage(value, child) {
    if (!value || !this.behavior.excrement_rate) { return; }

    const number = this.decimalForHash(child.hashedId);
    if (!this.chanceFor(value, number)) { return; }

    const blocks = this.randomNumberFor(this.behavior.excrement_within, child.hashedId);
    const fraction = 1.0 / this.behavior.excrement_rate;
    const modified = Math.floor(blocks * fraction);

    this.excrementAt.push(child.height + modified);
    this.excrementAt = this.excrementAt.sort();
  }

  performEffectForClearExcrement(value) {
    if (!value) { return; }
    this.excrement = 0;
  }

  performEffectForEvolutionOffset(value, toInvoke) {
    if (!value) { return; }
    this.stateIndex += value;

    if (this.stateIndex === 0) {
      this.behavior.health_decrement_at = this.blockInProgress + this.behavior.evolution_at[0];
      this.counter = 0;
      toInvoke.push(() => this.clearBuffs());
    }

    if (this.health > this.hearts) {
      this.health = this.hearts;
    }
  }

  performEffectForDeathIn(value, child) {
    const deathAt = child.height + value;
    if (!this.deathAt || this.deathAt > deathAt) {
      this.deathAt = deathAt;
    }
  }

  performEffectForRegenerateType(value, child) {
    if (!value) { return; }
    const number = this.decimalForHash(child.hashedId);
    const currentType = this.type;
    this._type = this.typeFor(number, { without: currentType });
    this.addHistoryEventFor(child.height, 'type_change', { previous_type: currentType, type: this.type });
  }

  performEffectForImmediatePercentage(key, value, child) {
    if (!value) { return; }
    const effect = /immediate_([^_]+)_percentage/.exec(key.toLowerCase())[1];
    const number = this.decimalForHash(child.hashedId);
    if (!this.immediateEffects[effect]) {
      this.immediateEffects[effect] = this.chanceFor(value, number);
    }
  }

  valueForBuff(key) {
    return this.buffs.reduce((acc, buff) => {
      const effects = this.effectsForBuff(buff);
      return acc * (effects[key] ?? 1);
    }, 1);
  }

  effectsForBuff(buff) {
    let effects = buff.effects;
    if (effects[EFFECTS.STATE_BASED_EFFECT]) {
      effects = effects[EFFECTS.STATE_BASED_EFFECT][this.stateIndex];
    }
    return effects || {};
  }

  get graveMessage() {
    if (!this._graveMessage) {
      const messages = this.configuration.translations.grave_messages;
      const index = this.randomNumberFor(messages.length, this.hash, { zeroAllowed: true });
      this._graveMessage = messages[index];
    }
    return this._graveMessage;
  }

  translate(key, data = {}) {
    const paths = key.split('.');
    let translation = this.configuration.translations;
    paths.forEach((path) => {
      translation = Object.hasOwn(translation, path) && translation[path];
    });

    if (!translation) {
      return `missing translation for ${key}!`;
    }

    Object.keys(data).forEach((key) => {
      const value = data[key];
      const regex = new RegExp(`%{${key}}`);
      translation = translation.replace(regex, value);
    });

    const remainingMatch = TRANSLATION_REGEX.exec(translation);
    if (remainingMatch) {
      return `translation interpolation value for "${remainingMatch[1]}" is missing!`;
    }
    return translation;
  }

  async hashFor(input) {
    const encoded = new TextEncoder().encode(input);
    const buffer = await globalThis.crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  get itemKeyLength() {
    if (!this._itemKeyLength) {
      const keys = Object.keys(this.configuration.items);
      const lengths = keys.map(k => k.length);
      this._itemKeyLength = Math.max(...lengths);
    }
    return this._itemKeyLength;
  }

  get speech() {
    if (!this._speech) {
      const scoped = this.configuration.speech[this.state];
      this._speech = {};

      Object.keys(scoped).forEach((key) => {
        const keys = Object.keys(scoped[key]);
        const phrases = {};

        keys.forEach((phrase) => {
          phrases[phrase] = scoped[key][phrase].match(/.{1,2}/g).map(byte => parseInt(byte, 16));
        });

        this._speech[key] = phrases;
      });
    }
    return this._speech;
  }

  speechPhraseExcluding(lastKey = null) {
    const priority = Math.floor(Math.random() * 2) === 0;
    const { phrases, keys } = this.currentSpeechGrouping({ priority });

    const length = keys.length;
    let key;
    let attempts = 0;

    do {
      attempts += 1;
      const index = Math.floor(Math.random() * length);
      key = keys[index];
      if (attempts > MAX_UNIQUE_SPEECH_LOOKUP_ATTEMPTS) {
        break;
      }
    } while (length > 1 && lastKey === key);

    return { lpc: phrases[key], key };
  }

  prioritySpeechGrouping() {
    let phrases = {}

    const addPhrasesWithPriorityFor = (currentPhrases) => {
      phrases = { ...phrases, ...currentPhrases };
    };

    if (this.excrement) {
      addPhrasesWithPriorityFor(this.speech.excrement);
    }

    this.buffs.forEach((buff) => {
      const buffPhrases = this.speech[buff.description];
      if (buffPhrases) {
        addPhrasesWithPriorityFor(buffPhrases);
      }
    });

    return { phrases, keys: Object.keys(phrases) };
  }

  currentSpeechGrouping(options = {}) {
    let phrases, keys;

    if (options?.priority) {
      let grouping = this.prioritySpeechGrouping();
      if (grouping.keys.length) {
        phrases = grouping.phrases;
        keys = grouping.keys;
      }
    } 

    if (!keys || !keys.length) {
      phrases = { ...this.speech.default };
      keys = Object.keys(phrases);
    }

    return { phrases, keys };
  }

  currentMusic() {
    let track;
    if (this.isAlive()) {
      const buff = !this.isFinalState() && this._buffs[this._buffs.length - 1]?.description;
      track = this.configuration.music.tracks[buff || this.state];
    } else {
      track = this.configuration.music.tracks.grave;
    }
    const tracks = [ track ?? null ].flat();
    if (tracks.indexOf(null) !== -1) {
      return null;
    }

    const id = tracks.sort().join(',');
    return { id, tracks, volume: this.configuration.music.volume };
  }

  get sysex() {
    return this.configuration.sfx?.sysex;
  }

  get nsf() {
    return this.configuration.music?.nsf;
  }

  set configuration(configuration) {
    this._configuration = configuration
    for (let i = 0, length = this.evolutionStates.length; i < length; i++) {
      const name = this.stateNameFor(i);
      if (name) {
        let key = name.toUpperCase();
        key = key.replace(/\s|-/g, '_');
        PIZZA_PET_STATES[key] = name;
      }
    }
  }

  get configuration() {
    return this._configuration;
  }

  isInDeathFixupRange(block) {
    const deathFixupRanges = this.configuration.deathfixup_blocks || [];
    return deathFixupRanges.some(range => 
      block >= range.start && block <= range.end
    );
  }
}
