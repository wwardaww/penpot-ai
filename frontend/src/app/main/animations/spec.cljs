;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.animations.spec
  "Penforge animation spec (W31): the JSON stored in the shape shared
  plugin data `penforge` / `animations`.

  Shape of the stored value (version 1, keys as in JSON):

    {v: 1,
     entrance?: Motion, exit?: Motion,
     states?: {hover?: State, press?: State},
     loop?: Loop,
     smart?: [{index, destination, duration, easing}]}

  Motion = {effects: [Effect], duration, delay?, easing?, stagger?, tracks?}
  Effect = {type: fade} | {type: slide, direction, distance?}
         | {type: scale, from?} | {type: blur, amount?}
  State  = {opacity?, scale?, offsetX?, offsetY?, fill?, shadow?, duration?, easing?}
  Loop   = {type: pulse|spin|bounce|shimmer, duration?, count?, delay?, easing?,
            intensity?}
  Easing = linear|ease|ease-in|ease-out|ease-in-out
         | {type: spring, stiffness?, damping?, mass?}

  `tracks` (free keyframes, a later work item) is accepted and kept, the
  presets compile to the same track format (`app.main.animations.presets`).
  The same contract is mirrored in TypeScript by
  `mcp/packages/plugin/src/penforge/animations.ts`."
  (:require
   [app.common.data :as d]
   [app.common.schema :as sm]
   [app.util.json :as json]))

(def plugin-namespace
  "Shared plugin data namespace, as the frontend stores it."
  :shared/penforge)

(def plugin-key "animations")

(def version 1)

(def easing-names
  ["linear" "ease" "ease-in" "ease-out" "ease-in-out"])

(def directions
  ["up" "down" "left" "right"])

(def effect-types
  ["fade" "slide" "scale" "blur"])

(def loop-types
  ["pulse" "spin" "bounce" "shimmer"])

(def track-props
  ["opacity" "translateX" "translateY" "scale" "rotate" "blur" "fill"])

(def stagger-origins
  ["first" "last" "center"])

(def ^:private schema:duration
  [:and number? [:>= 0] [:<= 20000]])

(def schema:spring
  [:map {:closed true}
   [:type [:= "spring"]]
   [:stiffness {:optional true} [:and number? [:> 0] [:<= 2000]]]
   [:damping {:optional true} [:and number? [:> 0] [:<= 500]]]
   [:mass {:optional true} [:and number? [:> 0] [:<= 50]]]])

(def schema:easing
  [:or (into [:enum] easing-names) schema:spring])

(def schema:color
  [:re #"^#[0-9a-fA-F]{6}$"])

(def schema:effect
  [:map {:closed true}
   [:type (into [:enum] effect-types)]
   [:direction {:optional true} (into [:enum] directions)]
   [:distance {:optional true} [:and number? [:>= -4000] [:<= 4000]]]
   [:from {:optional true} [:and number? [:>= 0] [:<= 10]]]
   [:amount {:optional true} [:and number? [:>= 0] [:<= 200]]]])

(def schema:keyframe
  [:map {:closed true}
   [:at [:and number? [:>= 0] [:<= 1]]]
   [:value [:or number? schema:color]]
   [:easing {:optional true} schema:easing]])

(def schema:track
  [:map {:closed true}
   [:prop (into [:enum] track-props)]
   [:keyframes [:vector {:min 1} schema:keyframe]]])

(def schema:stagger
  [:map {:closed true}
   [:each schema:duration]
   [:from {:optional true} (into [:enum] stagger-origins)]])

(def schema:motion
  [:map {:closed true}
   [:effects {:optional true} [:vector {:max 4} schema:effect]]
   [:tracks {:optional true} [:vector {:max 16} schema:track]]
   [:duration schema:duration]
   [:delay {:optional true} schema:duration]
   [:easing {:optional true} schema:easing]
   [:stagger {:optional true} schema:stagger]])

(def schema:shadow
  [:map {:closed true}
   [:offsetX {:optional true} number?]
   [:offsetY {:optional true} number?]
   [:blur {:optional true} [:and number? [:>= 0]]]
   [:spread {:optional true} number?]
   [:color {:optional true} schema:color]
   [:opacity {:optional true} [:and number? [:>= 0] [:<= 1]]]])

(def schema:state
  [:map {:closed true}
   [:opacity {:optional true} [:and number? [:>= 0] [:<= 1]]]
   [:scale {:optional true} [:and number? [:>= 0] [:<= 10]]]
   [:offsetX {:optional true} [:and number? [:>= -4000] [:<= 4000]]]
   [:offsetY {:optional true} [:and number? [:>= -4000] [:<= 4000]]]
   [:fill {:optional true} schema:color]
   [:shadow {:optional true} schema:shadow]
   [:duration {:optional true} schema:duration]
   [:easing {:optional true} schema:easing]])

(def schema:loop
  [:map {:closed true}
   [:type (into [:enum] loop-types)]
   [:duration {:optional true} [:and number? [:>= 50] [:<= 20000]]]
   [:count {:optional true} [:or [:= "infinite"] [:int {:min 1 :max 1000}]]]
   [:delay {:optional true} schema:duration]
   [:easing {:optional true} schema:easing]
   [:intensity {:optional true} [:and number? [:> 0] [:<= 10]]]])

(def schema:smart
  [:map {:closed true}
   [:index [:int {:min 0}]]
   [:destination {:optional true} [:maybe :string]]
   [:duration {:optional true} schema:duration]
   [:easing {:optional true} schema:easing]])

(def schema:animations
  [:map {:closed true}
   [:v [:= version]]
   [:entrance {:optional true} schema:motion]
   [:exit {:optional true} schema:motion]
   [:states {:optional true}
    [:map {:closed true}
     [:hover {:optional true} schema:state]
     [:press {:optional true} schema:state]]]
   [:loop {:optional true} schema:loop]
   [:smart {:optional true} [:vector {:max 64} schema:smart]]])

(def ^:private valid-animations?
  (sm/validator schema:animations))

(def ^:private explain-animations
  (sm/explainer schema:animations))

(defn- normalize
  "Drops empty sections so an emptied spec encodes to nothing."
  [spec]
  (cond-> spec
    (empty? (:states spec)) (dissoc :states)
    (empty? (:smart spec)) (dissoc :smart)))

(defn valid?
  [spec]
  (valid-animations? spec))

(defn explain
  "Human readable explanation of why `spec` is not valid, or nil."
  [spec]
  (some-> (explain-animations spec) (sm/simplify)))

(defn decode
  "Parses a stored JSON string. Returns the spec map, or nil when the value
  is missing, not JSON or not a valid version 1 spec."
  [value]
  (when (string? value)
    (let [spec (try (json/decode value) (catch :default _ nil))]
      (when (map? spec)
        (let [spec (normalize spec)]
          (when (valid? spec) spec))))))

(defn encode
  "Spec map to the stored JSON string; nil for an empty spec (removes the
  plugin data entry)."
  [spec]
  (let [spec (normalize spec)]
    (when (some #(contains? spec %) [:entrance :exit :states :loop :smart])
      (json/encode (assoc spec :v version)))))

(defn empty-spec
  []
  {:v version})

(defn get-stored-value
  "Raw stored JSON string of `shape`, or nil."
  [shape]
  (get-in shape [:plugin-data plugin-namespace plugin-key]))

(defn get-shape-animations
  "Valid animation spec of `shape`, or nil."
  [shape]
  (decode (get-stored-value shape)))

(defn has-animations?
  [shape]
  (some? (get-shape-animations shape)))

(defn get-smart
  "Smart animate options for the interaction `index` of `shape` going to
  `destination` (uuid), or nil. An entry whose destination no longer
  matches the interaction is ignored."
  [shape index destination]
  (when-let [spec (get-shape-animations shape)]
    (d/seek (fn [{entry-index :index entry-dest :destination}]
              (and (= index entry-index)
                   (or (nil? entry-dest)
                       (= entry-dest (some-> destination str)))))
            (:smart spec))))
