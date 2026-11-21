;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.workspace-device-screens-test
  "Device screen catalog, board placement and the add-boards event."
  (:require
   [app.common.data :as d]
   [app.common.files.helpers :as cfh]
   [app.common.math :as mth]
   [app.common.test-helpers.files :as cthf]
   [app.common.test-helpers.ids-map :as cthi]
   [app.common.test-helpers.shapes :as cths]
   [app.common.uuid :as uuid]
   [app.main.constants :as mconst]
   [app.main.data.changes :as dch]
   [app.main.data.helpers :as dsh]
   [app.main.data.workspace.device-screens :as dwds]
   [app.main.data.workspace.undo :as dwu]
   [app.main.devices :as devices]
   [beicon.v2.core :as rx]
   [cljs.test :as t :include-macros true]
   [frontend-tests.helpers.state :as ths]
   [potok.v2.core :as ptk]))

;; --- Catalog

(t/deftest catalog-ids-are-unique
  (let [ids (map :id devices/devices)]
    (t/is (= (count ids) (count (set ids))))))

(t/deftest catalog-sizes-are-positive-integers
  (doseq [{:keys [id width height states]} devices/devices
          size (into [{:width width :height height}] states)]
    (t/is (and (pos-int? (:width size)) (pos-int? (:height size)))
          (str id " has a bad size " size))))

(t/deftest catalog-groups-are-known-and-filled
  (t/is (every? (set devices/groups) (map :group devices/devices)))
  (doseq [group devices/groups]
    (t/is (seq (devices/group-devices group)) (str group " is empty"))))

(t/deftest tablets-and-foldables-have-states-phones-do-not
  (doseq [{:keys [id group] :as device} devices/devices]
    (if (contains? #{:phones :games} group)
      (t/is (not (devices/has-states? device)) (str id))
      (t/is (<= 2 (count (:states device))) (str id)))))

(t/deftest default-size-is-the-first-state
  (doseq [{:keys [id states] :as device} devices/devices
          :when (seq states)]
    (t/is (= (select-keys device [:width :height])
             (select-keys (first states) [:width :height]))
          (str id))))

(t/deftest catalog-has-the-requested-devices
  (doseq [id [:iphone-18-pro :iphone-18-pro-max :iphone-17 :galaxy-s26
              :galaxy-a56 :pixel-10 :ipad-pro-13 :galaxy-tab-s11
              :galaxy-z-fold-8 :galaxy-z-flip-8 :iphone-fold :surface-duo-2
              ;; W38 game screens
              :game-full-hd :game-qhd :game-hd :game-4k :game-steam-deck
              :game-mobile-landscape]]
    (t/is (some? (devices/get-device id)) (str id))))

;; --- Board specs

(def ^:private label name)

(t/deftest phone-makes-one-board-named-after-it
  (let [device (devices/get-device :iphone-17-pro)]
    (t/is (= [{:name "iPhone 17 Pro" :width 402 :height 874}]
             (devices/board-specs device false label)
             (devices/board-specs device true label)))))

(t/deftest foldable-without-states-makes-the-default-board
  (t/is (= [{:name "Galaxy Z Fold 8" :width 412 :height 960}]
           (devices/board-specs (devices/get-device :galaxy-z-fold-8) false label))))

(t/deftest foldable-with-states-makes-one-board-per-state
  (t/is (= [{:name "Galaxy Z Fold 8 / folded" :width 412 :height 960}
            {:name "Galaxy Z Fold 8 / unfolded" :width 750 :height 832}]
           (devices/board-specs (devices/get-device :galaxy-z-fold-8) true label))))

(t/deftest dual-screen-with-states-makes-each-screen-and-spanned
  (t/is (= ["Surface Duo 2 / left-screen"
            "Surface Duo 2 / right-screen"
            "Surface Duo 2 / spanned"]
           (map :name (devices/board-specs (devices/get-device :surface-duo-2)
                                           true label)))))

(t/deftest tablet-with-states-adds-landscape
  (t/is (= [{:name "iPad Air 11in / portrait" :width 820 :height 1180}
            {:name "iPad Air 11in / landscape" :width 1180 :height 820}]
           (devices/board-specs (devices/get-device :ipad-air-11) true label))))

;; --- Size presets of the design tab

(t/deftest size-preset-entries-skip-known-names
  (let [entries (devices/size-preset-entries #{"iPhone 17 Pro"})
        names   (set (map :name entries))]
    (t/is (not (contains? names "iPhone 17 Pro")))
    (t/is (contains? names "iPhone 17"))
    (t/is (contains? names "PHONES"))
    (t/is (contains? names "Galaxy Z Fold 8 / Folded"))
    (t/is (contains? names "Galaxy Z Fold 8 / Unfolded"))
    (t/is (not (contains? names "Galaxy Z Fold 8")))))

(t/deftest size-presets-hold-catalog-devices-once
  (let [sizes (filter :width mconst/size-presets)
        names (map :name sizes)]
    (t/is (some #{"iPhone 18 Pro"} names))
    (t/is (= 1 (count (filter #{"iPhone 16"} names))))
    (t/is (some #{"A4"} names) "the base presets stay")))

;; --- Placement

(t/deftest boards-go-right-of-the-occupied-area
  (t/is (= {:x 600 :y -50}
           (dwds/boards-origin {:x 100 :y -50 :width 400 :height 300}
                               {:x 0 :y 0}
                               [{:width 10 :height 10}]))))

(t/deftest boards-are-centered-on-an-empty-page
  ;; row: 400 + 100 gap + 200 = 700 wide, 300 high
  (t/is (= {:x 650 :y 350}
           (dwds/boards-origin nil {:x 1000 :y 500}
                               [{:width 400 :height 300}
                                {:width 200 :height 100}]))))

(t/deftest boards-start-at-the-origin-without-a-viewport
  (t/is (= {:x 0 :y 0}
           (dwds/boards-origin nil nil [{:width 400 :height 300}]))))

(t/deftest layout-boards-are-root-frames-in-a-row
  (let [boards (dwds/layout-boards [{:name "A" :width 400 :height 300}
                                    {:name "B" :width 200 :height 100}]
                                   {:x 10 :y 20})]
    (t/is (= [10 510] (map :x boards)))
    (t/is (= [20 20] (map :y boards)))
    (t/is (every? cfh/frame-shape? boards))
    (t/is (every? #(= uuid/zero (:parent-id %) (:frame-id %)) boards))))

;; --- Event

(defn- watch-undo-stack
  "Record undo entries for local commits, as `initialize-workspace` does
  in the app (the test store skips that bootstrap). Stops at `:the/end`."
  []
  (ptk/reify ::watch-undo-stack
    ptk/WatchEvent
    (watch [_ _ stream]
      (->> stream
           (rx/filter dch/commit?)
           (rx/map deref)
           (rx/mapcat
            (fn [{:keys [save-undo? undo-changes redo-changes undo-group tags stack-undo?
                         selected-before translation?]}]
              (if (and save-undo? (seq undo-changes))
                (rx/of (dwu/append-undo {:undo-changes undo-changes
                                         :redo-changes redo-changes
                                         :undo-group undo-group
                                         :tags tags
                                         :selected-before selected-before
                                         :translation (boolean translation?)}
                                        stack-undo?))
                (rx/empty))))
           (rx/take-until (rx/filter #(= :the/end %) stream))))))

(defn- sample-file
  []
  (-> (cthf/sample-file :file1 :page-label :page1)
      (cths/add-sample-shape :board1 :type :frame
                             :x 0 :y 0 :width 300 :height 200)))

(defn- new-boards
  [state]
  (->> (dsh/lookup-page-objects state)
       (vals)
       (filter #(and (cfh/frame-shape? %)
                     (not= (cthi/id :board1) (:id %))
                     (not= uuid/zero (:id %))))
       (sort-by :x)))

(t/deftest add-device-boards-adds-one-board-right-of-existing
  (t/async
    done
    (let [store (ths/setup-store (sample-file))]
      (ths/run-store
       store done
       [(watch-undo-stack)
        (dwds/add-device-boards :iphone-17-pro {})]
       (fn [state]
         (let [[board :as boards] (new-boards state)]
           (t/is (= 1 (count boards)))
           (t/is (= "iPhone 17 Pro" (:name board)))
           (t/is (= [402 874] [(:width board) (:height board)]))
           (t/is (= [400 0] [(:x board) (:y board)]) "right of board1, top aligned")
           (t/is (= uuid/zero (:parent-id board)))
           (t/is (= #{(:id board)} (set (dsh/lookup-selected state))))
           (t/is (= 1 (count (get-in state [:workspace-undo :items]))))))))))

(t/deftest add-device-boards-with-states-is-one-undo-step
  (t/async
    done
    (let [store (ths/setup-store (sample-file))
          check-undo
          (fn []
            (ths/run-store
             store done [dwu/undo]
             (fn [state]
               (t/is (empty? (new-boards state)) "undo removes every board"))))]
      (ths/run-store
       store check-undo
       [(watch-undo-stack)
        (dwds/add-device-boards :galaxy-z-fold-8 {:with-states true})]
       (fn [state]
         (let [boards (new-boards state)]
           (t/is (= 2 (count boards)))
           ;; `tr` answers the key in tests
           (t/is (= ["Galaxy Z Fold 8 / penforge.devices.state.folded"
                     "Galaxy Z Fold 8 / penforge.devices.state.unfolded"]
                    (map :name boards)))
           (t/is (= [400 912] (map :x boards)))
           (t/is (= 1 (count (get-in state [:workspace-undo :items]))))))))))

(t/deftest add-device-boards-ignores-unknown-devices
  (t/async
    done
    (let [store (ths/setup-store (sample-file))]
      (ths/run-store
       store done
       [(dwds/add-device-boards :no-such-device {})]
       (fn [state]
         (t/is (empty? (new-boards state))))))))

;; --- Resize every screen (W37)

(defn- b
  [id x y w h]
  {:id id :x x :y y :width w :height h})

(t/deftest board-rows-groups-by-vertical-band
  (let [rows (dwds/board-rows [(b :c 1000 0 400 800)
                               (b :a 0 0 400 800)
                               (b :d 0 900 400 800)
                               (b :b 500 10 400 780)])]
    (t/is (= [[:a :b :c] [:d]]
             (mapv #(mapv :id (:items %)) rows)))))

(t/deftest reflow-keeps-gaps-and-row-order
  ;; two rows of 400x800 boards, gap 100 both ways, resized to 440x956
  (let [boxes  [(b :a 0 0 400 800) (b :b 500 0 400 800) (b :c 1000 0 400 800)
                (b :d 0 900 400 800) (b :e 500 900 400 800)]
        placed (d/index-by :id (dwds/reflow-boards boxes 440 956))]
    (t/is (= [0 540 1080] (map #(get-in placed [% :x]) [:a :b :c])))
    (t/is (= [0 0 0] (map #(get-in placed [% :y]) [:a :b :c])))
    (t/is (= [0 540] (map #(get-in placed [% :x]) [:d :e])))
    (t/is (= [1056 1056] (map #(get-in placed [% :y]) [:d :e])) "956 + 100 gap")
    (t/is (every? #(= [440 956] [(:width %) (:height %)]) (vals placed)))))

(t/deftest reflow-keeps-each-gap-and-row-left-edge
  (let [boxes  [(b :a 50 0 400 800) (b :b 610 0 400 800)]
        placed (d/index-by :id (dwds/reflow-boards boxes 300 600))]
    (t/is (= 50 (get-in placed [:a :x])) "row keeps its left edge")
    (t/is (= 510 (get-in placed [:b :x])) "50 + 300 + the old 160 gap")))

(t/deftest reflow-separates-overlapping-boards
  (let [boxes  [(b :a 0 0 400 800) (b :b 300 0 400 800)]
        placed (d/index-by :id (dwds/reflow-boards boxes 400 800))]
    (t/is (= 500 (get-in placed [:b :x])) "overlap becomes the default gap")))

(t/deftest reflow-leaves-a-fitting-grid-alone
  (let [boxes [(b :a 0 0 440 956) (b :b 540 0 440 956)]]
    (t/is (= boxes (dwds/reflow-boards boxes 440 956)))))

(t/deftest reflow-grows-rows-without-overlap
  ;; phones become tablets: the second row moves down
  (let [boxes  [(b :a 0 0 400 800) (b :b 0 900 400 800)]
        placed (d/index-by :id (dwds/reflow-boards boxes 1024 1366))]
    (t/is (= 1466 (get-in placed [:b :y])))
    (t/is (<= (+ (get-in placed [:a :y]) 1366) (get-in placed [:b :y])))))

(defn- grid-file
  "Six 400x800 screens in two rows of three (gap 100) and a rect inside
  the first one."
  []
  (-> (cthf/sample-file :file1 :page-label :page1)
      (cths/add-sample-shape :s1 :type :frame :x 0 :y 0 :width 400 :height 800)
      (cths/add-sample-shape :s2 :type :frame :x 500 :y 0 :width 400 :height 800)
      (cths/add-sample-shape :s3 :type :frame :x 1000 :y 0 :width 400 :height 800)
      (cths/add-sample-shape :s4 :type :frame :x 0 :y 900 :width 400 :height 800)
      (cths/add-sample-shape :s5 :type :frame :x 500 :y 900 :width 400 :height 800)
      (cths/add-sample-shape :s6 :type :frame :x 1000 :y 900 :width 400 :height 800)
      (cths/add-sample-shape :r1 :type :rect :parent-label :s1
                             :x 10 :y 10 :width 50 :height 50)))

(defn- screens
  [state]
  (->> (dwds/screen-boards (dsh/lookup-page-objects state))
       (map (fn [s] (mapv mth/round [(:x s) (:y s) (:width s) (:height s)])))
       (sort)))

(t/deftest resize-screens-resizes-all-in-one-undo-step
  (t/async
    done
    (let [store (ths/setup-store (grid-file) {:renderer :svg})
          check-undo
          (fn []
            (ths/run-store
             store done [dwu/undo]
             (fn [state]
               (t/is (= [[0 0 400 800] [0 900 400 800] [500 0 400 800]
                         [500 900 400 800] [1000 0 400 800] [1000 900 400 800]]
                        (screens state))
                     "one undo restores every screen"))))]
      (ths/run-store
       store check-undo
       [(watch-undo-stack)
        (dwds/pick-device :iphone-16-pro-max {})]
       (fn [state]
         (t/is (= [[0 0 440 956] [0 1056 440 956] [540 0 440 956]
                   [540 1056 440 956] [1080 0 440 956] [1080 1056 440 956]]
                  (screens state)))
         (t/is (= 6 (count (dwds/screen-boards (dsh/lookup-page-objects state))))
               "no board added")
         (let [rect (get (dsh/lookup-page-objects state) (cthi/id :r1))]
           (t/is (= [10 10] (mapv mth/round [(:x rect) (:y rect)]))
                 "children follow constraints"))
         (t/is (= 1 (count (get-in state [:workspace-undo :items])))))))))

(t/deftest pick-device-on-an-empty-page-adds-a-board
  (t/async
    done
    (let [store (ths/setup-store (cthf/sample-file :file1 :page-label :page1)
                                 {:renderer :svg})]
      (ths/run-store
       store done
       [(dwds/pick-device :iphone-16-pro-max {})]
       (fn [state]
         (t/is (= [[0 0 440 956]] (screens state))))))))

(t/deftest pick-device-with-states-still-adds-breakpoint-boards
  (t/async
    done
    (let [store (ths/setup-store (sample-file) {:renderer :svg})]
      (ths/run-store
       store done
       [(dwds/pick-device :galaxy-z-fold-8 {:with-states true})]
       (fn [state]
         (t/is (= 2 (count (new-boards state))))
         (t/is (= [300 200] (let [b1 (get (dsh/lookup-page-objects state)
                                          (cthi/id :board1))]
                              [(:width b1) (:height b1)]))
               "existing screen untouched"))))))

(t/deftest pick-device-phone-with-states-on-resizes
  (t/async
    done
    (let [store (ths/setup-store (sample-file) {:renderer :svg})]
      (ths/run-store
       store done
       [(dwds/pick-device :iphone-17-pro {:with-states true})]
       (fn [state]
         (t/is (empty? (new-boards state)))
         (t/is (= [[0 0 402 874]] (screens state))))))))
