// Preset shape definitions (from test_pipeline.m)
const PRESETS = {
    "40mm Square": {
        outline: [[-20,-20],[20,-20],[20,20],[-20,20]],
        params: {}
    },
    "Hexagon": {
        outline: (function() {
            const R = 20, h = R * Math.sqrt(3) / 2;
            return [[-R/2,-h],[R/2,-h],[R,0],[R/2,h],[-R/2,h],[-R,0]];
        })(),
        params: {}
    },
    "L-Shape": {
        outline: [[-20,-20],[20,-20],[20,0],[5,0],[5,20],[-20,20]],
        params: {}
    },
    "Small Square (2.5mm)": {
        outline: [[-12,-12],[12,-12],[12,12],[-12,12]],
        params: {
            pixel_w_mm: 2.5, pixel_h_mm: 2.5,
            pitch_x_mm: 2.7, pitch_y_mm: 2.7,
            trace_w_mm: 0.15, gap_mm: 0.15, clearance_mm: 0.15,
            center_clear_mm: 0.15, edge_clear_mm: 0.08,
            via_dia_mm: 0.3, edge_keepout_mm: 0.4,
        }
    },
    "Wide Rectangle": {
        outline: [[-18,-8],[18,-8],[18,8],[-18,8]],
        params: {
            pixel_w_mm: 2.5, pixel_h_mm: 2.5,
            pitch_x_mm: 2.7, pitch_y_mm: 2.7,
            trace_w_mm: 0.15, gap_mm: 0.15, clearance_mm: 0.15,
            center_clear_mm: 0.15, edge_clear_mm: 0.08,
            via_dia_mm: 0.3, edge_keepout_mm: 0.4,
        }
    },
    "Large Square (6mm)": {
        outline: [[-25,-25],[25,-25],[25,25],[-25,25]],
        params: {
            pixel_w_mm: 6.0, pixel_h_mm: 6.0,
            pitch_x_mm: 6.4, pitch_y_mm: 6.4,
            cable_length_mm: 5.0,
        }
    },
    "Trapezoid": {
        outline: [[-20,-20],[20,-20],[30,20],[-30,20]],
        params: {
            pixel_w_mm: 6.0, pixel_h_mm: 6.0,
            pitch_x_mm: 6.4, pitch_y_mm: 6.4,
            cable_length_mm: 5.0,
        }
    },
    "Rect Pixel (5x3.5mm)": {
        outline: [[-22,-18],[22,-18],[22,18],[-22,18]],
        params: {
            pixel_w_mm: 5.0, pixel_h_mm: 3.5,
            pitch_x_mm: 5.2, pitch_y_mm: 3.7,
        }
    },
};
