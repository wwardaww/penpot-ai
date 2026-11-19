;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.workspace.device-screens
  "Device picker actions (`app.main.devices`): resize every screen of
  the current page to a device size and re-flow the grid, or add device
  boards right of the shapes already there. Each is one undo step."
  (:require
   [app.common.data :as d]
   [app.common.files.changes-builder :as pcb]
   [app.common.files.helpers :as cfh]
   [app.common.files.shapes-helpers :as cfsh]
   [app.common.geom.modifiers :as gm]
   [app.common.geom.point :as gpt]
   [app.common.geom.shapes :as gsh]
   [app.common.math :as mth]
   [app.common.types.modifiers :as ctm]
   [app.common.types.shape :as cts]
   [app.common.uuid :as uuid]
   [app.main.data.changes :as dch]
   [app.main.data.event :as ev]
   [app.main.data.helpers :as dsh]
   [app.main.data.workspace.modifiers :as dwm]
   [app.main.data.workspace.selection :as dws]
   [app.main.data.workspace.zoom :as dwz]
   [app.main.devices :as devices]
   [app.main.features :as features]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [potok.v2.core :as ptk]))

(def board-gap
  "Space between new boards, and between them and the shapes already
  on the page."
  100)

(defn state-label
  "The translated label of a device state."
  [state]
  (case state
    :portrait     (tr "penforge.devices.state.portrait")
    :landscape    (tr "penforge.devices.state.landscape")
    :folded       (tr "penforge.devices.state.folded")
    :unfolded     (tr "penforge.devices.state.unfolded")
    :cover        (tr "penforge.devices.state.cover")
    :left-screen  (tr "penforge.devices.state.left-screen")
    :right-screen (tr "penforge.devices.state.right-screen")
    :spanned      (tr "penforge.devices.state.spanned")
    (name state)))

(defn boards-origin
  "Top-left point for a row of boards of `specs` sizes. Right of
  `occupied` (the rect of the page's top-level shapes, nil on an empty
  page), top aligned with it; on an empty page the row is centered on
  `center` (or placed at the origin without one)."
  [occupied center specs]
  (if (some? occupied)
    {:x (+ (:x occupied) (:width occupied) board-gap)
     :y (:y occupied)}
    (let [row-width  (+ (reduce + (map :width specs))
                        (* board-gap (max 0 (dec (count specs)))))
          row-height (reduce max 0 (map :height specs))
          cx         (:x center 0)
          cy         (:y center 0)]
      (if (some? center)
        {:x (mth/round (- cx (/ row-width 2)))
         :y (mth/round (- cy (/ row-height 2)))}
        {:x 0 :y 0}))))

(defn layout-boards
  "Board shapes for `specs`, laid out left to right from `origin`, at
  the root of the page."
  [specs origin]
  (loop [specs  specs
         x      (:x origin)
         boards []]
    (if-let [{:keys [name width height]} (first specs)]
      (recur (rest specs)
             (+ x width board-gap)
             (conj boards
                   (cts/setup-shape {:type :frame
                                     :id (uuid/next)
                                     :name name
                                     :x x
                                     :y (:y origin)
                                     :width width
                                     :height height
                                     :parent-id uuid/zero
                                     :frame-id uuid/zero})))
      boards)))

(defn- occupied-rect
  [objects]
  (let [roots (cfh/get-immediate-children objects)]
    (when (seq roots)
      (gsh/shapes->rect roots))))

;; --- Resize every screen

(defn screen-boards
  "The screens of a page: its top-level boards, in page order."
  [objects]
  (filterv cfh/frame-shape? (cfh/get-immediate-children objects)))

(defn- box
  "Position and size of `board` (its selrect)."
  [board]
  (let [{:keys [x y width height]} (:selrect board)]
    {:id (:id board) :x x :y y :width width :height height}))

(defn- center-y
  [{:keys [y height]}]
  (+ y (/ height 2)))

(defn board-rows
  "Groups `boxes` (`{:id :x :y :width :height}`) into the rows of the
  canvas grid, top to bottom, each row left to right. A box joins the
  current row when its vertical center lies inside the band the row
  covers so far."
  [boxes]
  (let [sorted (sort-by (juxt :y :x) boxes)]
    (->> (reduce
          (fn [rows b]
            (let [row (peek rows)]
              (if (and (some? row)
                       (<= (:top row) (center-y b) (:bottom row)))
                (conj (pop rows)
                      (-> row
                          (update :items conj b)
                          (update :bottom max (+ (:y b) (:height b)))))
                (conj rows {:top (:y b)
                            :bottom (+ (:y b) (:height b))
                            :items [b]}))))
          []
          sorted)
         (mapv (fn [row] (update row :items #(vec (sort-by :x %))))))))

(defn- gap-or-default
  [gap]
  (if (neg? gap) board-gap gap))

(defn reflow-boards
  "New positions of `boxes` once each is `width` × `height`: the same
  rows, row order and left-to-right order as before, every row keeps
  its left edge, and the gaps between boards and between rows stay as
  they were (a negative gap, from boards that overlapped, becomes
  `board-gap`). The first row keeps its top. Returns a vector of
  `{:id :x :y :width :height}`."
  [boxes width height]
  (let [rows (board-rows boxes)]
    (loop [rows     rows
           prev     nil
           new-top  nil
           result   []]
      (if-let [{:keys [top items] :as row} (first rows)]
        (let [new-top (if (nil? prev)
                        top
                        (+ new-top
                           (:new-height prev)
                           (gap-or-default (- top (:bottom prev)))))
              placed  (loop [items  items
                             before nil
                             x      nil
                             acc    []]
                        (if-let [b (first items)]
                          (let [x (if (nil? before)
                                    (:x b)
                                    (+ x width
                                       (gap-or-default
                                        (- (:x b) (+ (:x before) (:width before))))))]
                            (recur (rest items) b x
                                   (conj acc {:id (:id b)
                                              :x x
                                              :y (+ new-top (- (:y b) top))
                                              :width width
                                              :height height})))
                          acc))
              row-h   (- (reduce max 0 (map #(+ (:y %) (:height %)) placed))
                         new-top)]
          (recur (rest rows)
                 (assoc row :new-height row-h)
                 new-top
                 (into result placed)))
        result))))

(defn- board-modifiers
  "Modifiers that give `board` the size and position of `target`: a
  resize from its top-left corner, then a move. Children follow their
  constraints and layout, as with a manual resize."
  [board target]
  (let [{:keys [x y]} (:selrect board)]
    (-> (ctm/change-size board (:width target) (:height target))
        (ctm/move (gpt/point (- (:x target) x) (- (:y target) y))))))

(defn- changed?
  [current target]
  (not= (select-keys current [:x :y :width :height])
        (select-keys target [:x :y :width :height])))

(defn resize-screens
  "Resizes every screen (top-level board) of the current page to
  `width` × `height` in one undo step and re-flows the grid so they do
  not overlap (`reflow-boards`). Nothing happens when every screen
  already has that size and place."
  [width height]
  (ptk/reify ::resize-screens
    ptk/WatchEvent
    (watch [_ state _]
      (let [page-id (:current-page-id state)
            objects (dsh/lookup-page-objects state page-id)
            boards  (screen-boards objects)
            boxes   (mapv box boards)
            by-id   (d/index-by :id boxes)
            targets (->> (reflow-boards boxes width height)
                         (filter #(changed? (get by-id (:id %)) %))
                         (d/index-by :id))
            ids     (vec (keys targets))]
        (if (empty? ids)
          (rx/empty)
          (let [modif-tree (dwm/build-modif-tree
                            ids objects
                            #(board-modifiers % (get targets (:id %))))]
            (if (features/active-feature? state "render-wasm/v1")
              (rx/of (dwm/apply-wasm-modifiers modif-tree {:ignore-snap-pixel true}))
              (rx/of (dwm/apply-modifiers*
                      objects
                      (gm/set-objects-modifiers modif-tree objects)
                      nil
                      nil)))))))))

(defn add-device-boards
  "Adds the boards of the catalog device `device-id` to the current
  page in one commit, selects them and brings them into view. With
  `with-states`, a device with states (tablet, foldable or dual
  screen) gets one board per state instead of one."
  [device-id {:keys [with-states]}]
  (ptk/reify ::add-device-boards
    ptk/WatchEvent
    (watch [it state _]
      (if-let [device (devices/get-device device-id)]
        (let [page-id (:current-page-id state)
              objects (dsh/lookup-page-objects state page-id)
              specs   (devices/board-specs device with-states state-label)
              origin  (boards-origin (occupied-rect objects)
                                     (dsh/get-viewport-center state)
                                     specs)
              boards  (layout-boards specs origin)
              changes (reduce (fn [changes board]
                                (second (cfsh/prepare-add-shape changes board objects)))
                              (-> (pcb/empty-changes it page-id)
                                  (pcb/with-objects objects))
                              boards)
              ids     (into (d/ordered-set) (map :id) boards)]
          (rx/of (dch/commit-changes changes)
                 (dws/select-shapes ids)
                 (when (get-in state [:workspace-local :vport])
                   (dwz/fit-to-shapes ids))
                 (ev/event {::ev/name "add-device-boards"
                            ::ev/origin "workspace:device-screens"
                            :device (name device-id)
                            :boards (count boards)})))
        (rx/empty)))))

(defn pick-device
  "The device picker's action. A page with screens gets every screen
  resized to the device's default size (`resize-screens`). An empty
  page, or a device with states while `with-states` is on (breakpoint
  layouts are new boards by nature), gets new boards
  (`add-device-boards`)."
  [device-id {:keys [with-states] :as options}]
  (ptk/reify ::pick-device
    ptk/WatchEvent
    (watch [_ state _]
      (if-let [device (devices/get-device device-id)]
        (let [objects (dsh/lookup-page-objects state (:current-page-id state))
              screens (screen-boards objects)]
          (if (or (empty? screens)
                  (and with-states (devices/has-states? device)))
            (rx/of (add-device-boards device-id options))
            (rx/of (resize-screens (:width device) (:height device))
                   (ev/event {::ev/name "resize-device-screens"
                              ::ev/origin "workspace:device-screens"
                              :device (name device-id)
                              :boards (count screens)}))))
        (rx/empty)))))
