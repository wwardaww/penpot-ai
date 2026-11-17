;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.binfile.fig.map-test
  "The mapping of a Figma document to penpot file data, without the
  database: the fixture is encoded and decoded through the real reader."
  (:require
   [app.binfile.fig.container :as container]
   [app.binfile.fig.map :as fig.map]
   [app.binfile.fig.tree :as tree]
   [app.common.files.validate :as cfv]
   [app.common.uuid :as uuid]
   [backend-tests.binfile.fig.fixtures :as fx]
   [clojure.test :as t]))

(defn- mapped
  "The fixture decoded and mapped, with the stored image faked."
  []
  (let [{:keys [image]} (fx/medium-document)
        doc     (container/read-file (fx/medium-fig!))
        media   {(:hash image) {:id (uuid/next) :width 2 :height 1 :mtype "image/png" :name "photo"}}
        file-id (uuid/next)]
    (assoc (fig.map/map-document (tree/index (:message doc))
                                 {:file-id file-id :name "Fixture" :project-id (uuid/next) :media media})
           :media media)))

(defn- objects-by-name
  [file]
  (->> (vals (get-in file [:data :pages-index]))
       (mapcat (comp vals :objects))
       (group-by :name)))

(defn- one [file name]
  (let [found (get (objects-by-name file) name)]
    (assert (= 1 (count found)) (str "expected one shape named " name ", found " (count found)))
    (first found)))

(t/deftest pages-are-mapped-and-the-internal-canvas-is-not
  (let [{:keys [file]} (mapped)
        pages (vals (get-in file [:data :pages-index]))]
    (t/is (= #{"Page 1"} (into #{} (map :name) pages)))))

(t/deftest an-auto-layout-frame-becomes-a-flex-board
  (let [{:keys [file]} (mapped)
        card (one file "Card")]
    (t/is (= :frame (:type card)))
    (t/is (= :flex (:layout card)))
    (t/is (= :column (:layout-flex-dir card)))
    (t/is (= 8.0 (get-in card [:layout-gap :row-gap])))
    (t/is (= {:p1 16.0 :p2 16.0 :p3 16.0 :p4 16.0} (:layout-padding card)))
    (t/is (= :center (:layout-align-items card)))
    (t/is (= :auto (:layout-item-v-sizing card)) "the card hugs its content vertically")
    (t/is (= [100.0 50.0 200.0 300.0] ((juxt :x :y :width :height) card)))
    (t/is (= 12.0 (:r1 card)))
    (t/is (= :drop-shadow (get-in card [:shadow 0 :style])))
    (t/testing "children go in reversed: penpot lays out flex children from the top layer"
      (let [objects (->> (vals (get-in file [:data :pages-index]))
                         (some #(when (contains? (:objects %) (:id card)) (:objects %))))]
        (t/is (= ["Buy button" "Photo" "Title"]
                 (mapv #(:name (get objects %)) (:shapes card))))))
    (t/testing "a stretched child fills the cross axis"
      (t/is (= :fill (:layout-item-h-sizing (one file "Photo")))))))

(t/deftest text-keeps-paragraphs-runs-and-styles
  (let [{:keys [file]} (mapped)
        title      (one file "Title")
        paragraphs (get-in title [:content :children 0 :children])
        [hello world] paragraphs]
    (t/is (= :text (:type title)))
    (t/is (= :auto-height (:grow-type title)))
    (t/is (= 2 (count paragraphs)))
    (t/is (= ["Hel" "lo"] (mapv :text (:children hello))))
    (t/is (= ["400" "700"] (mapv :font-weight (:children hello))))
    (t/is (= ["World"] (mapv :text (:children world))))
    (t/is (= "gfont-inter" (get-in hello [:children 0 :font-id])))
    (t/is (= "1.5" (get-in hello [:children 0 :line-height])) "24px over 16px")
    (t/testing "the text style links the library typography"
      (t/is (some? (get-in hello [:children 0 :typography-ref-id]))))))

(t/deftest styles-become-library-assets
  (let [{:keys [file]} (mapped)
        colors (vals (get-in file [:data :colors]))
        typos  (vals (get-in file [:data :typographies]))]
    (t/is (= [["Brand" "Blue" "#0066ff"]] (mapv (juxt :path :name :color) colors)))
    (t/is (= [["Heading" "Body" "gfont-inter" "16"]]
             (mapv (juxt :path :name :font-id :font-size) typos)))
    (t/testing "a fill that uses a style references the library color"
      (let [default (->> (objects-by-name file)
                         (vals)
                         (apply concat)
                         (filter #(= "Default" (:variant-name %)))
                         (first))]
        (t/is (= (:id (first colors)) (get-in default [:fills 0 :fill-color-ref-id])))))))

(t/deftest an-image-fill-points-at-the-stored-media
  (let [{:keys [file media]} (mapped)
        photo (one file "Photo")
        fill  (first (:fills photo))]
    (t/is (= (:id (first (vals media))) (get-in fill [:fill-image :id])))
    (t/is (true? (get-in fill [:fill-image :keep-aspect-ratio])))))

(t/deftest vectors-groups-and-booleans
  (let [{:keys [file]} (mapped)]
    (t/is (= :path (:type (one file "Triangle"))))
    (t/is (= :path (:type (one file "Rule"))) "a line keeps its open path")
    (t/is (= :circle (:type (one file "Dot"))))
    (t/is (= :group (:type (one file "Group"))))
    (let [diamond (one file "Diamond")]
      (t/is (= :rect (:type diamond)))
      (t/is (< (Math/abs (- 45.0 (:rotation diamond))) 1e-6)))
    (let [union (one file "Union")]
      (t/is (= :bool (:type union)))
      (t/is (= :union (:bool-type union)))
      (t/is (= "#0066ff" (get-in union [:fills 0 :fill-color]))))))

(t/deftest components-variants-and-instances
  (let [{:keys [file]} (mapped)
        data       (:data file)
        objects    (->> (vals (:pages-index data)) (mapcat (comp vals :objects)))
        by-id      (into {} (map (juxt :id identity)) objects)
        container  (first (filter :is-variant-container objects))
        mains      (filter :main-instance objects)
        copy       (one file "Buy button")
        label      (get by-id (first (:shapes copy)))]
    (t/is (= "Button" (:name container)))
    (t/is (= 2 (count mains)))
    (t/is (= 2 (count (:components data))))
    (t/is (every? #(= (:id container) (:variant-id %)) mains))
    (t/is (= #{"Default" "Hover"} (into #{} (map :variant-name) mains)))
    (t/is (= #{[{:name "State" :value "Default"}] [{:name "State" :value "Hover"}]}
             (into #{} (map :variant-properties) (vals (:components data)))))
    (t/testing "the instance is a copy of the default variant"
      (t/is (:component-root copy))
      (t/is (= (:id file) (:component-file copy)))
      (t/is (contains? (into #{} (map :id) mains) (:shape-ref copy))))
    (t/testing "the overridden text is kept and marked as touched"
      (t/is (= "Buy" (get-in label [:content :children 0 :children 0 :children 0 :text])))
      (t/is (contains? (:touched label) :content-group))
      (t/is (some? (get by-id (:shape-ref label)))))))

(t/deftest the-report-lists-what-was-not-imported
  (let [{:keys [report]} (mapped)]
    (t/is (= 1 (:total report)))
    (t/is (= [{:fig-type "STICKY" :reason "node type STICKY not supported" :count 1}]
             (:summary report)))
    (t/is (= ["Inter"] (:fonts report)))
    (t/is (= 1 (get-in report [:counts :pages])))))

(t/deftest the-mapped-file-is-valid
  (let [{:keys [file]} (mapped)]
    (t/is (nil? (cfv/validate-file file {})))))
