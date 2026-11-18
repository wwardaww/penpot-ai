;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.activity.overlay
  "Canvas effect where the AI works (W25).

  While the AI may change the design (a chat turn streams or a workflow
  runs, see `app.main.data.ai.chat/busy?`), the shapes changed by local
  commits on the current page are collected, plus the layers attached
  to the message that started the work. Their area shows a soft,
  animated glow with an \"AI\" badge, one region per top-level board
  (or root shape), computed from the current shapes so it grows with
  them. It fades out when the work ends.

  The commits of the hidden MCP plugin (the AI) cannot be told apart
  from the user's own edits made meanwhile, so those glow too.

  Mounted in the viewport controls layer of both renderers (SVG and
  render-wasm), in canvas coordinates; it never takes pointer events.
  With `prefers-reduced-motion` the highlight stays still."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data :as d]
   [app.common.geom.rect :as grc]
   [app.common.uuid :as uuid]
   [app.main.data.ai.chat :as chat]
   [app.main.data.changes :as dch]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [okulary.core :as l]
   [potok.v2.core :as ptk]
   [rumext.v2 :as mf]))

(def fade-out-ms
  "How long the effect takes to disappear after the work ends."
  700)

;; --- Pure helpers

(defn changed-ids
  "Ids of the shapes of `page-id` that `changes` (redo changes of a
  commit) add, modify or move."
  [changes page-id]
  (into #{}
        (comp (filter #(= page-id (:page-id %)))
              (mapcat (fn [{:keys [type id shapes parent-id]}]
                        (case type
                          (:add-obj :mod-obj) [id]
                          :mov-objects (cons parent-id shapes)
                          nil)))
              (filter uuid?)
              (remove #(= uuid/zero %)))
        changes))

(defn root-id
  "Id of the top-level ancestor of the shape `id` (a board or a shape
  directly on the page), or the shape itself."
  [objects id]
  (loop [id id]
    (let [parent-id (get-in objects [id :parent-id])]
      (if (or (nil? parent-id) (= uuid/zero parent-id) (not (contains? objects parent-id)))
        id
        (recur parent-id)))))

(defn- shape-rect
  [shape]
  (if-let [points (not-empty (:points shape))]
    (grc/points->rect points)
    (:selrect shape)))

(defn regions
  "Areas to highlight: one rect per top-level ancestor of the existing
  shapes in `ids`, covering those shapes. Sorted by key for a stable
  order."
  [objects ids]
  (->> ids
       (filter #(contains? objects %))
       (group-by #(root-id objects %))
       (keep (fn [[key ids]]
               (when-let [rect (->> ids
                                    (keep #(shape-rect (get objects %)))
                                    (not-empty)
                                    (grc/join-rects))]
                 {:key key :rect rect})))
       (sort-by (comp str :key))
       (vec)))

(defn attached-ids
  "Ids of the layers of `page-id` attached to the newest user message of
  the chat (the selection the work started from)."
  [chat page-id]
  (let [entry (d/seek #(= :user (:kind %)) (some-> (:entries chat) not-empty rseq))]
    (into #{}
          (comp (filter #(= "node" (:kind %)))
                (filter #(= (str page-id) (:page-id %)))
                (keep #(uuid/parse* (:node-id %))))
          (:attachments entry))))

(defn- reduced-motion?
  []
  (and (fn? (.-matchMedia js/window))
       (boolean (.-matches (.matchMedia js/window "(prefers-reduced-motion: reduce)")))))

;; --- Components

(def ^:private ref:busy
  (l/derived #(chat/busy? (get-in % [:penforge :chat])) st/state))

(def ^:private gradient-id "penforge-ai-activity-gradient")
(def ^:private shimmer-id "penforge-ai-activity-shimmer")
(def ^:private glow-id "penforge-ai-activity-glow")

(mf/defc activity-defs*
  {::mf/private true}
  [{:keys [zoom animate]}]
  [:defs
   [:linearGradient {:id gradient-id :x1 "0" :y1 "0" :x2 "1" :y2 "1"}
    [:stop {:offset "0" :stop-color "#7c5cff"}]
    [:stop {:offset "0.5" :stop-color "#22c3ff"}]
    [:stop {:offset "1" :stop-color "#ff5fb0"}]]
   [:linearGradient {:id shimmer-id :x1 "0" :y1 "0" :x2 "1" :y2 "0"}
    [:stop {:offset "0" :stop-color "#22c3ff" :stop-opacity "0"}]
    [:stop {:offset "0.5" :stop-color "#ffffff" :stop-opacity "0.55"}]
    [:stop {:offset "1" :stop-color "#7c5cff" :stop-opacity "0"}]
    (when animate
      [:animateTransform {:attributeName "gradientTransform"
                          :type "translate"
                          :from "-1 0"
                          :to "1 0"
                          :dur "1.8s"
                          :repeatCount "indefinite"}])]
   [:filter {:id glow-id :x "-50%" :y "-50%" :width "200%" :height "200%"}
    [:feGaussianBlur {:stdDeviation (/ 8 zoom)}]]])

(mf/defc activity-region*
  {::mf/private true}
  [{:keys [rect zoom badge]}]
  (let [pad    (/ 4 zoom)
        x      (- (:x rect) pad)
        y      (- (:y rect) pad)
        width  (+ (:width rect) (* 2 pad))
        height (+ (:height rect) (* 2 pad))
        radius (/ 6 zoom)
        stroke (str "url(#" gradient-id ")")]
    [:g {:class (stl/css :region)}
     [:rect {:class (stl/css :glow)
             :x x :y y :width width :height height :rx radius
             :fill "none"
             :stroke stroke
             :stroke-width (/ 10 zoom)
             :filter (str "url(#" glow-id ")")}]
     [:rect {:class (stl/css :shimmer)
             :x x :y y :width width :height height :rx radius
             :fill (str "url(#" shimmer-id ")")}]
     [:rect {:x x :y y :width width :height height :rx radius
             :fill "none"
             :stroke stroke
             :stroke-width (/ 2 zoom)}]
     ;; The badge keeps its screen size: drawn in pixels, scaled by 1/zoom.
     [:g {:transform (str "translate(" x "," (- y (/ 24 zoom)) ") scale(" (/ 1 zoom) ")")}
      [:rect {:width 44 :height 20 :rx 10 :fill stroke}]
      [:path {:class (stl/css :sparkle)
              :d "M12 4l1.4 4.6L18 10l-4.6 1.4L12 16l-1.4-4.6L6 10l4.6-1.4z"}]
      [:text {:class (stl/css :badge-text) :x 21 :y 14} badge]]]))

(mf/defc ai-activity*
  "Glow over the canvas area the AI is changing. Props: `zoom`,
  `page-id`."
  [{:keys [zoom page-id]}]
  (let [busy     (mf/deref ref:busy)
        objects  (mf/deref refs/workspace-page-objects)
        ids*     (mf/use-state #{})
        ids      (deref ids*)
        leaving* (mf/use-state false)
        leaving  (deref leaving*)
        animate  (mf/with-memo [] (not (reduced-motion?)))
        regions  (mf/with-memo [ids objects]
                   (when (seq ids) (regions objects ids)))]

    (mf/with-effect [busy page-id]
      (if busy
        (let [subscription
              (->> st/stream
                   (rx/filter (ptk/type? ::dch/commit))
                   (rx/map deref)
                   (rx/filter #(= :local (:source %)))
                   (rx/map #(changed-ids (:redo-changes %) page-id))
                   (rx/filter seq)
                   (rx/subs! #(swap! ids* into %)))]
          (reset! leaving* false)
          (reset! ids* (attached-ids (get-in @st/state [:penforge :chat]) page-id))
          #(rx/dispose! subscription))
        (let [timer (js/setTimeout #(reset! ids* #{}) fade-out-ms)]
          (reset! leaving* true)
          #(js/clearTimeout timer))))

    (when (seq regions)
      [:g {:class (stl/css-case :activity true
                                :animated animate
                                :leaving leaving)
           :style {:pointer-events "none"}
           :aria-hidden true
           :data-testid "ai-activity"}
       [:> activity-defs* {:zoom zoom :animate animate}]
       (for [{:keys [key rect]} regions]
         [:> activity-region* {:key (str key)
                               :rect rect
                               :zoom zoom
                               :badge (tr "penforge.activity.badge")}])])))
