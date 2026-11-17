;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.binfile.fig.geom
  "Geometry of a Figma document: affine transforms and the two binary
  blobs that hold vector data.

  A transform is a plain vector `[a b c d e f]` with the meaning of a
  SVG matrix: `x' = a·x + c·y + e`, `y' = b·x + d·y + f`. A Figma
  `transform` struct stores `m00 m01 m02 m10 m11 m12`, so `a = m00`,
  `c = m01`, `e = m02`, `b = m10`, `d = m11` and `f = m12`.

  Path segments come out in the plain format penpot path content is
  built from: `{:command :move-to|:line-to|:curve-to|:close-path
  :params {...}}`."
  (:require
   [app.common.exceptions :as ex])
  (:import
   java.nio.BufferUnderflowException
   java.nio.ByteBuffer
   java.nio.ByteOrder))

(set! *warn-on-reflection* true)

(def identity-matrix [1.0 0.0 0.0 1.0 0.0 0.0])

(defn from-fig
  "The transform a Figma `transform` struct describes; identity when it
  is missing."
  [{:keys [m00 m01 m02 m10 m11 m12] :as m}]
  (if (nil? m)
    identity-matrix
    [(double (or m00 1)) (double (or m10 0))
     (double (or m01 0)) (double (or m11 1))
     (double (or m02 0)) (double (or m12 0))]))

(defn multiply
  "The transform that applies `m2` first and then `m1`."
  [[a1 b1 c1 d1 e1 f1] [a2 b2 c2 d2 e2 f2]]
  [(+ (* a1 a2) (* c1 b2))
   (+ (* b1 a2) (* d1 b2))
   (+ (* a1 c2) (* c1 d2))
   (+ (* b1 c2) (* d1 d2))
   (+ (* a1 e2) (* c1 f2) e1)
   (+ (* b1 e2) (* d1 f2) f1)])

(defn apply-point
  [[a b c d e f] [x y]]
  [(+ (* a x) (* c y) e)
   (+ (* b x) (* d y) f)])

(defn invert
  "The inverse of a transform, or nil when it is singular."
  [[a b c d e f]]
  (let [det (- (* a d) (* b c))]
    (when-not (< (Math/abs (double det)) 1e-12)
      (let [ia (/ d det)
            ib (/ (- b) det)
            ic (/ (- c) det)
            id (/ a det)]
        [ia ib ic id
         (- (+ (* ia e) (* ic f)))
         (- (+ (* ib e) (* id f)))]))))

(defn determinant
  [[a b c d]]
  (- (* a d) (* b c)))

(defn linear-identity?
  "Whether the linear part of a transform is the identity, within a
  rounding tolerance."
  [[a b c d]]
  (and (< (Math/abs (- (double a) 1.0)) 1e-6)
       (< (Math/abs (double b)) 1e-6)
       (< (Math/abs (double c)) 1e-6)
       (< (Math/abs (- (double d) 1.0)) 1e-6)))

(defn rotation
  "The rotation of a transform in degrees, in [0, 360)."
  [[a b]]
  (let [deg (Math/toDegrees (Math/atan2 (double b) (double a)))
        deg (mod deg 360.0)]
    (if (< (- 360.0 deg) 1e-6) 0.0 deg)))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; BLOBS
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn- invalid
  [hint]
  (ex/raise :type :validation
            :code :invalid-fig-file
            :hint hint))

(defn- le-buffer
  ^ByteBuffer [^bytes data]
  (-> (ByteBuffer/wrap data)
      (.order ByteOrder/LITTLE_ENDIAN)))

(defn- point
  [m x y]
  (let [[x y] (apply-point m [x y])]
    {:x x :y y}))

(defn decode-commands
  "The segments of a commands blob, the outline Figma stores for a
  filled or stroked geometry: an opcode byte followed by float32 little
  endian arguments. Coordinates are mapped through `m`.

  A quadratic curve becomes the cubic curve that draws the same arc,
  since penpot paths only have cubic curves."
  [^bytes data m]
  (try
    (let [bb (le-buffer data)]
      (loop [out     (transient [])
             current [0.0 0.0]
             start   [0.0 0.0]]
        (if-not (.hasRemaining bb)
          (persistent! out)
          (let [op (bit-and (.get bb) 0xff)]
            (case op
              0 (recur (conj! out {:command :close-path :params {}}) start start)
              1 (let [p [(double (.getFloat bb)) (double (.getFloat bb))]]
                  (recur (conj! out {:command :move-to :params (point m (p 0) (p 1))}) p p))
              2 (let [p [(double (.getFloat bb)) (double (.getFloat bb))]]
                  (recur (conj! out {:command :line-to :params (point m (p 0) (p 1))}) p start))
              3 (let [[x0 y0] current
                      qx (double (.getFloat bb)) qy (double (.getFloat bb))
                      x  (double (.getFloat bb)) y  (double (.getFloat bb))
                      c1 (point m (+ x0 (* 2/3 (- qx x0))) (+ y0 (* 2/3 (- qy y0))))
                      c2 (point m (+ x (* 2/3 (- qx x))) (+ y (* 2/3 (- qy y))))
                      p  (point m x y)]
                  (recur (conj! out {:command :curve-to
                                     :params {:x (:x p) :y (:y p)
                                              :c1x (:x c1) :c1y (:y c1)
                                              :c2x (:x c2) :c2y (:y c2)}})
                         [x y] start))
              4 (let [c1x (double (.getFloat bb)) c1y (double (.getFloat bb))
                      c2x (double (.getFloat bb)) c2y (double (.getFloat bb))
                      x   (double (.getFloat bb)) y   (double (.getFloat bb))
                      c1  (point m c1x c1y)
                      c2  (point m c2x c2y)
                      p   (point m x y)]
                  (recur (conj! out {:command :curve-to
                                     :params {:x (:x p) :y (:y p)
                                              :c1x (:x c1) :c1y (:y c1)
                                              :c2x (:x c2) :c2y (:y c2)}})
                         [x y] start))
              (invalid "unknown command in a path blob"))))))
    (catch BufferUnderflowException _
      (invalid "truncated path blob"))))

(defn decode-vector-network
  "The vertices, segments and regions of a vector network blob, in the
  coordinates of the blob (the `normalizedSize` space)."
  [^bytes data]
  (try
    (let [bb      (le-buffer data)
          nvert   (bit-and (.getInt bb) 0xffffffff)
          nseg    (bit-and (.getInt bb) 0xffffffff)
          nreg    (bit-and (.getInt bb) 0xffffffff)
          _       (when (> (+ (* 12 nvert) (* 28 nseg)) (.remaining bb))
                    (invalid "truncated vector network blob"))
          verts   (vec (repeatedly nvert
                                   (fn []
                                     (let [_style (.getInt bb)]
                                       [(double (.getFloat bb)) (double (.getFloat bb))]))))
          segs    (vec (repeatedly nseg
                                   (fn []
                                     (let [_style (.getInt bb)
                                           start  (bit-and (.getInt bb) 0xffffffff)
                                           sdx    (double (.getFloat bb))
                                           sdy    (double (.getFloat bb))
                                           end    (bit-and (.getInt bb) 0xffffffff)
                                           edx    (double (.getFloat bb))
                                           edy    (double (.getFloat bb))]
                                       (when (or (>= start nvert) (>= end nvert))
                                         (invalid "vector network segment out of range"))
                                       {:start start :start-tangent [sdx sdy]
                                        :end end :end-tangent [edx edy]}))))
          regions (vec (repeatedly nreg
                                   (fn []
                                     (let [flags  (bit-and (.getInt bb) 0xffffffff)
                                           nloops (bit-and (.getInt bb) 0xffffffff)
                                           _      (when (> nloops (.remaining bb))
                                                    (invalid "truncated vector network blob"))
                                           loops  (vec (repeatedly nloops
                                                                   (fn []
                                                                     (let [n (bit-and (.getInt bb) 0xffffffff)]
                                                                       (when (> (* 4 n) (.remaining bb))
                                                                         (invalid "truncated vector network blob"))
                                                                       (vec (repeatedly n #(bit-and (.getInt bb) 0xffffffff)))))))]
                                       {:winding (if (zero? (bit-and flags 1)) :evenodd :nonzero)
                                        :loops   loops}))))]
      {:vertices verts :segments segs :regions regions})
    (catch BufferUnderflowException _
      (invalid "truncated vector network blob"))))

(defn- segment-command
  "The command that draws one network segment from `from` to `to`: a line
  when both tangents are zero, a cubic curve otherwise."
  [m vertices {:keys [start-tangent end-tangent]} from to]
  (let [[x0 y0] (nth vertices from)
        [x1 y1] (nth vertices to)
        [sdx sdy] start-tangent
        [edx edy] end-tangent
        p (point m x1 y1)]
    (if (and (zero? sdx) (zero? sdy) (zero? edx) (zero? edy))
      {:command :line-to :params p}
      (let [c1 (point m (+ x0 sdx) (+ y0 sdy))
            c2 (point m (+ x1 edx) (+ y1 edy))]
        {:command :curve-to
         :params {:x (:x p) :y (:y p)
                  :c1x (:x c1) :c1y (:y c1)
                  :c2x (:x c2) :c2y (:y c2)}}))))

(defn- oriented-segment
  "A segment walked from `from`: a segment stored the other way round has
  its ends and tangents swapped."
  [{:keys [start end start-tangent end-tangent] :as seg} from]
  (if (= start from)
    seg
    {:start end :end start :start-tangent end-tangent :end-tangent start-tangent}))

(defn network->segments
  "The path segments of a vector network, mapped through `m`: every loop
  of every region as a closed subpath, then every segment no region uses
  as an open subpath, so lines and open curves keep their stroke."
  [{:keys [vertices segments regions]} m]
  (let [used (into #{} (comp (mapcat :loops) cat) regions)
        out  (volatile! [])]
    (doseq [{:keys [loops]} regions
            lp loops
            :when (seq lp)]
      (let [first-seg (nth segments (first lp))
            ;; the walk starts where the first segment meets the last
            ;; one, so it follows the loop whichever way it was stored
            last-seg  (nth segments (peek lp))
            start     (if (contains? #{(:start last-seg) (:end last-seg)} (:start first-seg))
                        (:start first-seg)
                        (:end first-seg))
            [x y]     (nth vertices start)]
        (vswap! out conj {:command :move-to :params (point m x y)})
        (loop [idxs lp current start]
          (when-let [idx (first idxs)]
            (let [seg (oriented-segment (nth segments idx) current)]
              (vswap! out conj (segment-command m vertices seg (:start seg) (:end seg)))
              (recur (rest idxs) (:end seg)))))
        (vswap! out conj {:command :close-path :params {}})))
    (doseq [[idx seg] (map-indexed vector segments)
            :when (not (contains? used idx))]
      (let [[x y] (nth vertices (:start seg))]
        (vswap! out conj {:command :move-to :params (point m x y)})
        (vswap! out conj (segment-command m vertices seg (:start seg) (:end seg)))))
    @out))
