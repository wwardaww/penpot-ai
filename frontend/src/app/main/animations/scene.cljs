;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.animations.scene
  "Pure planning: which clips play on which layers and when.

  Entry = {:id layer-id :clip clip :start ms}; `sample` turns a list of
  entries into layer values at a time."
  (:require
   [app.common.data :as d]
   [app.common.files.helpers :as cfh]
   [app.common.geom.rect :as grc]
   [app.main.animations.easing :as ease]
   [app.main.animations.presets :as presets]
   [app.main.animations.spec :as spec]
   [app.main.animations.timeline :as tl]
   [cuerdas.core :as str]))

(def preview-loop-iterations
  "Endless loops play this many times in a canvas preview."
  2)

(def preview-exit-pause 400)

(defn get-animated-shapes
  "Shapes with a valid spec among `ids` and all their descendants, in tree
  order (parents first)."
  [objects ids]
  (->> ids
       (mapcat #(cfh/get-children-ids-with-self objects %))
       (distinct)
       (keep (fn [id]
               (when-let [shape (get objects id)]
                 (when-let [anim (spec/get-shape-animations shape)]
                   [shape anim]))))))

(defn motion-entries
  "Entries of the `kind` (:entrance|:exit) motions of `ids` and their
  descendants, scheduled at `start`. A motion with `stagger` animates the
  direct children of its layer, one after the other, instead of the layer."
  [objects ids kind start]
  (into []
        (mapcat
         (fn [[shape anim]]
           (when-let [motion (get anim kind)]
             (let [clip     (presets/motion-clip motion kind)
                   children (:shapes shape)]
               (if (and (some? (:stagger motion)) (seq children))
                 (let [delays (tl/stagger-delays objects children (:stagger motion))]
                   (for [[child-id extra] delays]
                     {:id child-id :clip (update clip :delay + extra) :start start}))
                 [{:id (:id shape) :clip clip :start start}])))))
        (get-animated-shapes objects ids)))

(defn loop-entries
  "Entries of the loops of `ids` and their descendants. `max-iterations`
  caps endless loops (canvas preview); nil keeps them endless."
  [objects ids start max-iterations]
  (into []
        (keep (fn [[shape anim]]
                (when-let [lp (:loop anim)]
                  (let [clip (presets/loop-clip lp)
                        clip (cond-> clip
                               (and (some? max-iterations) (infinite? (:iterations clip)))
                               (assoc :iterations max-iterations))]
                    {:id (:id shape) :clip clip :start start}))))
        (get-animated-shapes objects ids)))

(defn entries-end
  "Elapsed ms when the last entry ends (##Inf with an endless one)."
  [entries]
  (reduce (fn [acc {:keys [clip start]}] (max acc (+ start (tl/clip-end clip))))
          0
          entries))

(defn preview-plan
  "Canvas preview of `ids`: entrances, loops (endless ones capped), then
  exits after a short pause."
  [objects ids]
  (let [entrance   (motion-entries objects ids :entrance 0)
        loops      (loop-entries objects ids 0 preview-loop-iterations)
        before     (max (entries-end entrance) (entries-end loops))
        exits      (motion-entries objects ids :exit 0)
        exit-start (if (seq exits) (+ before (if (pos? before) preview-exit-pause 0)) 0)
        exits      (mapv #(assoc % :start exit-start) exits)
        entries    (-> [] (into entrance) (into loops) (into exits))]
    {:entries entries
     :duration (entries-end entries)}))

(defn screen-plan
  "View mode, screen enter: entrances and (endless) loops of the board."
  [objects frame-id]
  (into (motion-entries objects [frame-id] :entrance 0)
        (loop-entries objects [frame-id] 0 nil)))

(defn exit-plan
  [objects frame-id]
  (motion-entries objects [frame-id] :exit 0))

(defn sample
  "Layer id → combined values of `entries` at `elapsed` ms. Entries not
  started yet are ignored."
  [entries elapsed]
  (reduce (fn [acc {:keys [id clip start]}]
            (if (< elapsed start)
              acc
              (update acc id #(tl/combine (or % {}) (tl/sample-clip clip (- elapsed start))))))
          {}
          entries))

(defn finished?
  [entries elapsed]
  (>= elapsed (entries-end entries)))

;; --- Smart animate

(defn- name-paths
  "Layer id → name path below `frame-id` (\"Header/Title\"); the n-th
  layer with the same path gets \"#n\" appended so pairs match in order."
  [objects frame-id]
  (let [ids (cfh/get-children-ids objects frame-id)]
    (loop [ids ids seen {} out {}]
      (if-let [id (first ids)]
        (let [path  (->> (cfh/get-parent-ids objects id)
                         (take-while #(not= % frame-id))
                         (reverse)
                         (mapv #(:name (get objects %))))
              path  (str/join "/" (conj path (:name (get objects id))))
              n     (get seen path 0)
              key   (if (zero? n) path (str path "#" n))]
          (recur (rest ids) (assoc seen path (inc n)) (assoc out id key)))
        out))))

(defn match-layers
  "Pairs of [from-id to-id] whose name paths match between the boards."
  [objects from-frame-id to-frame-id]
  (let [from (into {} (map (fn [[id path]] [path id])) (name-paths objects from-frame-id))]
    (into []
          (keep (fn [[id path]] (when-let [from-id (get from path)] [from-id id])))
          (name-paths objects to-frame-id))))

(defn- first-fill-color
  [shape]
  (some-> (:fills shape) first :fill-color))

(defn- smart-tracks
  "Tracks moving `to` (a layer of the destination board) from where its
  pair `from` was in the origin board."
  [from to offset]
  (let [fr      (:selrect from)
        tr      (:selrect to)
        fc      (grc/rect->center fr)
        tc      (grc/rect->center tr)
        dx      (- (+ (:x fc) (:x offset)) (:x tc))
        dy      (- (+ (:y fc) (:y offset)) (:y tc))
        sx      (if (pos? (:width tr)) (/ (:width fr) (:width tr)) 1)
        sy      (if (pos? (:height tr)) (/ (:height fr) (:height tr)) 1)
        fo      (or (:opacity from) 1)
        to-o    (or (:opacity to) 1)
        ffill   (first-fill-color from)
        tfill   (first-fill-color to)
        radius? (and (some? (:r1 from)) (some? (:r1 to)) (not= (:r1 from) (:r1 to)))
        track   (fn [prop a b] {:prop prop :keyframes [{:at 0 :value a} {:at 1 :value b}]})]
    (cond-> []
      (not (zero? dx)) (conj (track :translateX dx 0))
      (not (zero? dy)) (conj (track :translateY dy 0))
      (not= sx 1) (conj (track :scaleX sx 1))
      (not= sy 1) (conj (track :scaleY sy 1))
      (and (pos? to-o) (not= fo to-o)) (conj (track :opacity (/ fo to-o) 1))
      (and ffill tfill (not= ffill tfill) (not (cfh/text-shape? to))) (conj (track :fill ffill tfill))
      radius? (conj (track :radius (:r1 from) (:r1 to))))))

(defn smart-plan
  "Entries and the set of absolute ids to move the destination board
  `to-frame-id` from the origin board: matched layers move/resize/fade/
  recolor from their origin state; layers only in the destination fade
  in (the top-most of each new branch)."
  [objects from-frame-id to-frame-id {:keys [duration easing]}]
  (let [from-frame (get objects from-frame-id)
        to-frame   (get objects to-frame-id)
        offset     {:x (- (:x (:selrect to-frame)) (:x (:selrect from-frame)))
                    :y (- (:y (:selrect to-frame)) (:y (:selrect from-frame)))}
        pairs      (match-layers objects from-frame-id to-frame-id)
        matched    (into #{} (map second) pairs)
        clip-base  {:delay 0
                    :duration (ease/get-duration easing (or duration 300))
                    :iterations 1
                    :easing (ease/get-easing easing "ease-in-out")}
        moved      (into []
                         (keep (fn [[from-id to-id]]
                                 (let [tracks (smart-tracks (get objects from-id) (get objects to-id) offset)]
                                   (when (seq tracks)
                                     {:id to-id :clip (assoc clip-base :tracks tracks) :start 0}))))
                         pairs)
        new-roots  (->> (cfh/get-children-ids objects to-frame-id)
                        (remove matched)
                        (filter (fn [id]
                                  (let [parent (:parent-id (get objects id))]
                                    (or (= parent to-frame-id) (contains? matched parent))))))
        faded      (mapv (fn [id]
                           {:id id
                            :clip (assoc clip-base :tracks [{:prop :opacity
                                                             :keyframes [{:at 0 :value 0} {:at 1 :value 1}]}])
                            :start 0})
                         new-roots)]
    {:entries (into moved faded)
     :absolute (into #{} (map :id) moved)}))

(defn get-smart-options
  "Smart animate options of the interaction `index` of `shape` towards
  `destination`, or nil."
  [shape index destination]
  (spec/get-smart shape index destination))

(defn interaction-index
  [shape interaction]
  (d/index-of (:interactions shape) interaction))
