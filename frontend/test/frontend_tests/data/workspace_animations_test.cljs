;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.workspace-animations-test
  "Penforge animations (W31): spec, easing, presets, timeline, scene,
  states, override geometry and the edit changes."
  (:require
   [app.common.files.changes-builder :as pcb]
   [app.common.geom.matrix :as gmt]
   [app.common.geom.point :as gpt]
   [app.common.test-helpers.files :as cthf]
   [app.common.test-helpers.ids-map :as cthi]
   [app.common.test-helpers.shapes :as cths]
   [app.main.animations.easing :as ease]
   [app.main.animations.presets :as presets]
   [app.main.animations.render :as render]
   [app.main.animations.scene :as scene]
   [app.main.animations.spec :as spec]
   [app.main.animations.states :as states]
   [app.main.animations.timeline :as tl]
   [app.main.data.workspace.animations.events :as dwa]
   [app.main.ui.workspace.sidebar.options.menus.animations.animations :as menu]
   [cljs.test :as t :include-macros true]))

(defn- close?
  ([a b] (close? a b 0.001))
  ([a b eps] (< (js/Math.abs (- a b)) eps)))

(def card-entrance
  {:v 1
   :entrance {:effects [{:type "fade"} {:type "slide" :direction "up" :distance 24}]
              :duration 300
              :easing "ease-out"
              :stagger {:each 50}}})

(defn- with-spec
  [anim]
  {:plugin-data {spec/plugin-namespace {spec/plugin-key (spec/encode anim)}}})

;; --- Sample file: a card board with three rows, a second screen

(defn- sample-file
  []
  (-> (cthf/sample-file :file1 :page-label :page1)
      (cths/add-sample-shape :card :type :frame :name "Card"
                             :x 0 :y 0 :width 300 :height 300)
      (cths/add-sample-shape :row-c :parent-label :card :name "C"
                             :x 0 :y 200 :width 300 :height 50)
      (cths/add-sample-shape :row-a :parent-label :card :name "A"
                             :x 0 :y 0 :width 300 :height 50)
      (cths/add-sample-shape :row-b :parent-label :card :name "B"
                             :x 0 :y 100 :width 300 :height 50)))

(defn- objects-of
  [file]
  (:objects (cthf/current-page file)))

(defn- with-anim
  [objects label anim]
  (update objects (cthi/id label) merge (with-spec anim)))

;; --- Spec

(t/deftest spec-round-trip
  (let [raw (spec/encode card-entrance)]
    (t/is (string? raw))
    (t/is (= card-entrance (spec/decode raw)))))

(t/deftest spec-refuses-invalid-values
  (t/is (nil? (spec/decode nil)))
  (t/is (nil? (spec/decode "{oops")))
  (t/is (nil? (spec/decode "{\"v\":2}")))
  (t/is (nil? (spec/decode "{\"v\":1,\"loop\":{\"type\":\"wobble\"}}")))
  (t/is (nil? (spec/decode "{\"v\":1,\"entrance\":{\"effects\":[{\"type\":\"fade\"}]}}"))
        "duration is required")
  (t/is (nil? (spec/decode "{\"v\":1,\"states\":{\"hover\":{\"fill\":\"red\"}}}")))
  (t/is (some? (spec/explain {:v 1 :extra true}))))

(t/deftest spec-accepts-the-full-shape
  (let [anim {:v 1
              :entrance {:effects [{:type "scale" :from 0.9}] :duration 250 :delay 100
                         :easing {:type "spring" :stiffness 200 :damping 20}}
              :exit {:effects [{:type "blur" :amount 6}] :duration 200}
              :states {:hover {:scale 1.05 :offsetY -2 :fill "#112233"
                               :shadow {:offsetY 8 :blur 24 :opacity 0.2}}
                       :press {:scale 0.97 :duration 80 :easing "ease-in"}}
              :loop {:type "spin" :duration 900 :count "infinite"}
              :smart [{:index 0 :destination "board-2" :duration 300 :easing "ease-in-out"}]}]
    (t/is (spec/valid? anim) (pr-str (spec/explain anim)))
    (t/is (= anim (spec/decode (spec/encode anim))))))

(t/deftest spec-encode-empty-removes
  (t/is (nil? (spec/encode {:v 1})))
  (t/is (nil? (spec/encode {:v 1 :states {} :smart []}))))

(t/deftest spec-smart-entry-follows-destination
  (let [dest  #uuid "00000000-0000-0000-0000-0000000000b2"
        shape (with-spec {:v 1 :smart [{:index 0 :destination (str dest)}]})]
    (t/is (some? (spec/get-smart shape 0 dest)))
    (t/is (nil? (spec/get-smart shape 1 dest)))
    (t/is (nil? (spec/get-smart shape 0 #uuid "00000000-0000-0000-0000-0000000000c3")))))

;; --- Easing

(t/deftest named-easings-hit-their-ends
  (doseq [[name f] ease/named]
    (t/is (close? 0 (f 0)) name)
    (t/is (close? 1 (f 1)) name))
  (let [f (get ease/named "ease-in-out")]
    (t/is (close? 0.5 (f 0.5) 0.01))
    (t/is (< (f 0.25) 0.25))))

(t/deftest spring-settles-and-overshoots
  (let [bouncy {:type "spring" :stiffness 300 :damping 10}
        f      (ease/spring bouncy)
        d      (ease/spring-duration bouncy)]
    (t/is (< 50 d 5000))
    (t/is (close? 1 (f 1)))
    (t/is (some #(> (f %) 1.01) (range 0 1 0.02)) "an underdamped spring overshoots")
    (t/is (= d (ease/get-duration bouncy 999)))
    (t/is (= 300 (ease/get-duration "ease" 300)))))

;; --- Presets and timeline

(t/deftest fade-slide-up-clip
  (let [clip (presets/motion-clip (:entrance card-entrance) :entrance)]
    (t/is (= 300 (:duration clip)))
    (t/is (= {:opacity 0 :translateY 24} (tl/sample-clip clip 0)))
    (t/is (= {:opacity 1 :translateY 0} (tl/sample-clip clip 300)))
    (let [mid (tl/sample-clip clip 150)]
      (t/is (< 0 (:opacity mid) 1))
      (t/is (< 0 (:translateY mid) 24)))))

(t/deftest exit-slide-moves-the-named-way
  (let [clip (presets/motion-clip {:effects [{:type "slide" :direction "up"}] :duration 200} :exit)]
    (t/is (= {:translateY 0} (tl/sample-clip clip 0)))
    (t/is (= {:translateY -24} (tl/sample-clip clip 200)))))

(t/deftest delay-holds-the-first-keyframe
  (let [clip (presets/motion-clip {:effects [{:type "fade"}] :duration 100 :delay 50} :entrance)]
    (t/is (= {:opacity 0} (tl/sample-clip clip 0)))
    (t/is (= {:opacity 0} (tl/sample-clip clip 50)))
    (t/is (= {:opacity 1} (tl/sample-clip clip 1000)))))

(t/deftest loops-repeat-and-stop
  (let [clip (presets/loop-clip {:type "spin" :duration 1000 :count 2})]
    (t/is (close? 180 (:rotate (tl/sample-clip clip 500))))
    (t/is (close? 180 (:rotate (tl/sample-clip clip 1500))))
    (t/is (close? 360 (:rotate (tl/sample-clip clip 2500))))
    (t/is (tl/clip-done? clip 2000))
    (t/is (not (tl/clip-done? clip 1999))))
  (let [endless (presets/loop-clip {:type "pulse"})]
    (t/is (infinite? (:iterations endless)))
    (t/is (not (tl/clip-done? endless 1e9)))
    (t/is (< 1 (:scale (tl/sample-clip endless 500))))))

(t/deftest keyframes-interpolate-colors
  (t/is (= "#808080" (tl/sample-keyframes [{:at 0 :value "#000000"} {:at 1 :value "#ffffff"}] 0.5)))
  (t/is (= 5 (tl/sample-keyframes [{:at 0 :value 0} {:at 0.5 :value 10} {:at 1 :value 0}] 0.75))))

(t/deftest combine-multiplies-adds-and-maxes
  (t/is (= {:opacity 0.25 :translateY 15 :blur 8 :fill "#ffffff"}
           (tl/combine {:opacity 0.5 :translateY 10 :blur 8 :fill "#000000"}
                       {:opacity 0.5 :translateY 5 :blur 2 :fill "#ffffff"}))))

;; --- Scene

(t/deftest stagger-plays-children-in-reading-order
  (let [file    (sample-file)
        objects (-> (objects-of file) (with-anim :card card-entrance))
        entries (scene/motion-entries objects [(cthi/id :card)] :entrance 0)
        delays  (into {} (map (juxt :id #(get-in % [:clip :delay]))) entries)]
    (t/is (= 3 (count entries)) "the card itself does not move")
    (t/is (= {(cthi/id :row-a) 0 (cthi/id :row-b) 50 (cthi/id :row-c) 100} delays))
    (let [at-40 (scene/sample entries 40)]
      (t/is (< 0 (get-in at-40 [(cthi/id :row-a) :opacity]) 1))
      (t/is (= 0 (get-in at-40 [(cthi/id :row-b) :opacity])) "B waits, hidden")
      (t/is (= 0 (get-in at-40 [(cthi/id :row-c) :opacity]))))
    (t/is (scene/finished? entries 400))
    (t/is (= {:opacity 1 :translateY 0} (get (scene/sample entries 400) (cthi/id :row-c))))))

(t/deftest stagger-from-center
  (let [file    (sample-file)
        ids     [(cthi/id :row-a) (cthi/id :row-b) (cthi/id :row-c)]
        delays  (tl/stagger-delays (objects-of file) ids {:each 40 :from "center"})]
    (t/is (= {(cthi/id :row-a) 40 (cthi/id :row-b) 0 (cthi/id :row-c) 40} delays))))

(t/deftest preview-plan-caps-endless-loops-and-ends-with-exit
  (let [file    (sample-file)
        objects (-> (objects-of file)
                    (with-anim :card {:v 1
                                      :entrance {:effects [{:type "fade"}] :duration 300}
                                      :exit {:effects [{:type "fade"}] :duration 200}})
                    (with-anim :row-a {:v 1 :loop {:type "spin" :duration 500}}))
        {:keys [entries duration]} (scene/preview-plan objects [(cthi/id :card)])
        exit    (some #(when (= :exit (get-in % [:clip :kind])) %) entries)]
    (t/is (= 3 (count entries)))
    (t/is (= (* 500 scene/preview-loop-iterations) (some #(when (= :loop (get-in % [:clip :kind])) (tl/clip-end (:clip %))) entries)))
    (t/is (= (+ 1000 scene/preview-exit-pause) (:start exit)))
    (t/is (= (+ 1000 scene/preview-exit-pause 200) duration))
    (t/is (= 1 (get-in (scene/sample entries 600) [(cthi/id :card) :opacity]))
          "the exit has not started yet")))

(t/deftest smart-animate-matches-by-name-path
  (let [file    (-> (sample-file)
                    (cths/add-sample-shape :screen2 :type :frame :name "Card 2"
                                           :x 1000 :y 0 :width 300 :height 300)
                    (cths/add-sample-shape :a2 :parent-label :screen2 :name "A"
                                           :x 1000 :y 150 :width 150 :height 50)
                    (cths/add-sample-shape :new2 :parent-label :screen2 :name "New"
                                           :x 1000 :y 0 :width 50 :height 50))
        objects (objects-of file)
        pairs   (scene/match-layers objects (cthi/id :card) (cthi/id :screen2))
        {:keys [entries absolute]}
        (scene/smart-plan objects (cthi/id :card) (cthi/id :screen2) {:duration 300})
        by-id   (into {} (map (juxt :id identity)) entries)
        start   (scene/sample entries 0)
        end     (scene/sample entries 300)]
    (t/is (= [[(cthi/id :row-a) (cthi/id :a2)]] pairs))
    (t/is (= #{(cthi/id :a2)} absolute))
    ;; A sat at y 0..50, width 300 in the first board: B starts there.
    (t/is (close? (- 25 175) (get-in start [(cthi/id :a2) :translateY])))
    (t/is (close? 75 (get-in start [(cthi/id :a2) :translateX])))
    (t/is (close? 2 (get-in start [(cthi/id :a2) :scaleX])))
    (t/is (close? 0 (get-in end [(cthi/id :a2) :translateY])))
    (t/is (= 0 (get-in start [(cthi/id :new2) :opacity])) "new layers fade in")
    (t/is (contains? by-id (cthi/id :new2)))))

;; --- States

(t/deftest hover-and-press-blend
  (let [shape   {:id :x :opacity 1 :fills [{:fill-color "#000000" :fill-opacity 1}]}
        st-spec {:hover {:scale 1.1 :fill "#ffffff"}
                 :press {:scale 0.9}}
        now     1000
        hovered (states/set-target {} :x :hover 1 (:hover st-spec) now false)]
    (t/is (nil? (states/layer-values shape st-spec {} now)) "at rest: no override")
    (t/is (nil? (states/layer-values shape st-spec (get hovered :x) now))
          "a transition starts from rest")
    (let [v (states/layer-values shape st-spec (get hovered :x) (+ now 1000))]
      (t/is (close? 1.1 (:scale v)))
      (t/is (= "#ffffff" (:fill v))))
    (let [pressed (states/set-target hovered :x :press 1 (:press st-spec) (+ now 1000) false)
          v       (states/layer-values shape st-spec (get pressed :x) (+ now 2000))]
      (t/is (close? 0.9 (:scale v)))
      (t/is (= "#ffffff" (:fill v)) "press keeps the hover fill"))
    (let [instant (states/set-target {} :x :hover 1 (:hover st-spec) now true)]
      (t/is (states/settled? instant now) "reduce motion jumps"))))

;; --- Override geometry (no renderer needed)

(t/deftest children-inherit-the-animated-parent-matrix
  (let [file    (sample-file)
        objects (objects-of file)
        card    (cthi/id :card)
        row-a   (cthi/id :row-a)
        worlds  (render/world-matrices objects {card {:translateY 24} row-a {:opacity 0.5}} #{})]
    (t/is (= #{card row-a (cthi/id :row-b) (cthi/id :row-c)} (set (keys worlds))))
    (t/is (= (gmt/translate-matrix 0 24) (get worlds row-a)))
    (t/is (empty? (render/world-matrices objects {row-a {:opacity 0.5}} #{})))))

(t/deftest scale-is-around-the-layer-center
  (let [file    (sample-file)
        objects (objects-of file)
        row-b   (get objects (cthi/id :row-b))
        m       (render/own-matrix row-b {:scale 2})
        center  (gpt/transform (gpt/point 150 125) m)]
    (t/is (close? 150 (:x center)))
    (t/is (close? 125 (:y center)))))

(t/deftest absolute-layers-ignore-ancestors
  (let [file    (sample-file)
        objects (objects-of file)
        card    (cthi/id :card)
        row-a   (cthi/id :row-a)
        worlds  (render/world-matrices objects {card {:translateX 10} row-a {:translateX 5}} #{row-a})]
    (t/is (= (gmt/translate-matrix 5 0) (get worlds row-a)))
    (t/is (= (gmt/translate-matrix 10 0) (get worlds (cthi/id :row-b))))))

;; --- Editing

(t/deftest edit-writes-plugin-data-with-undo
  (let [file    (sample-file)
        page-id (cthf/current-page-id file)
        objects (objects-of file)
        changes (-> (pcb/empty-changes nil page-id)
                    (pcb/with-file-data (:data file))
                    (dwa/get-changes objects page-id [(cthi/id :card)]
                                     #(menu/update-section % :entrance (:entrance card-entrance))))
        file'   (cthf/apply-changes file changes :validate? false)
        card'   (get (objects-of file') (cthi/id :card))
        undone  (cthf/apply-undo-changes file' changes)]
    (t/is (= 1 (count (:redo-changes changes))))
    (t/is (= (dissoc card-entrance :entrance)
             (dissoc (spec/get-shape-animations card') :entrance)))
    (t/is (= (:entrance card-entrance) (:entrance (spec/get-shape-animations card'))))
    (t/is (nil? (spec/get-shape-animations (get (objects-of undone) (cthi/id :card)))))))

(t/deftest edit-to-empty-removes-the-entry-and-skips-no-ops
  (let [file    (sample-file)
        page-id (cthf/current-page-id file)
        objects (-> (objects-of file) (with-anim :card card-entrance))
        clear   (-> (pcb/empty-changes nil page-id)
                    (pcb/with-file-data (:data file))
                    (dwa/get-changes objects page-id [(cthi/id :card)] #(dissoc % :entrance)))
        same    (-> (pcb/empty-changes nil page-id)
                    (pcb/with-file-data (:data file))
                    (dwa/get-changes objects page-id [(cthi/id :card)] identity))]
    (t/is (nil? (:value (first (:redo-changes clear)))))
    (t/is (empty? (:redo-changes same)))))

;; --- Editor helpers

(t/deftest presets-detect-and-apply
  (t/is (= "fade-slide-up" (menu/get-preset-id (:entrance card-entrance))))
  (t/is (= "none" (menu/get-preset-id nil)))
  (t/is (= "custom" (menu/get-preset-id {:effects [{:type "blur"} {:type "scale"}] :duration 100})))
  (let [m (menu/apply-preset (:entrance card-entrance) "scale")]
    (t/is (= [{:type "scale"}] (:effects m)))
    (t/is (= 300 (:duration m)) "timing is kept")
    (t/is (= {:each 50} (:stagger m))))
  (t/is (nil? (menu/apply-preset nil "none"))))

(t/deftest smart-toggle-keeps-other-entries
  (let [anim (menu/set-smart {:v 1 :smart [{:index 1 :destination "b"}]} 0 "c" true)]
    (t/is (= #{0 1} (set (map :index (:smart anim)))))
    (t/is (= {:v 1 :smart [{:index 1 :destination "b"}]}
             (menu/set-smart anim 0 "c" false)))
    (t/is (= {:v 1} (menu/set-smart {:v 1 :smart [{:index 0}]} 0 "c" false)))))
