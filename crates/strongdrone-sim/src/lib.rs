use rapier3d::prelude::*;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
pub struct V3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
pub struct Q4 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub w: f32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Observation {
    pub tick: u32,
    pub position: V3,
    pub velocity: V3,
    pub orientation: Q4,
    pub angular_velocity: V3,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Action {
    Velocity { v: V3 },
    Goto { target: V3 },
    Hover,
    Land,
}

#[wasm_bindgen]
pub struct Sim {
    physics_pipeline: PhysicsPipeline,
    integration_parameters: IntegrationParameters,
    island_manager: IslandManager,
    broad_phase: DefaultBroadPhase,
    narrow_phase: NarrowPhase,
    rigid_body_set: RigidBodySet,
    collider_set: ColliderSet,
    impulse_joint_set: ImpulseJointSet,
    multibody_joint_set: MultibodyJointSet,
    ccd_solver: CCDSolver,
    query_pipeline: QueryPipeline,
    drone_handle: RigidBodyHandle,
    tick: u32,
    current_action: Action,
}

#[wasm_bindgen]
impl Sim {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Sim {
        let mut rigid_body_set = RigidBodySet::new();
        let mut collider_set = ColliderSet::new();

        let ground = RigidBodyBuilder::fixed().build();
        let ground_handle = rigid_body_set.insert(ground);
        let ground_collider = ColliderBuilder::cuboid(50.0, 0.1, 50.0)
            .translation(vector![0.0, -0.1, 0.0])
            .build();
        collider_set.insert_with_parent(ground_collider, ground_handle, &mut rigid_body_set);

        let drone = RigidBodyBuilder::dynamic()
            .translation(vector![0.0, 1.5, 0.0])
            .linear_damping(0.5)
            .angular_damping(2.0)
            .build();
        let drone_handle = rigid_body_set.insert(drone);
        let drone_collider = ColliderBuilder::cuboid(0.15, 0.05, 0.15)
            .density(1.5)
            .build();
        collider_set.insert_with_parent(drone_collider, drone_handle, &mut rigid_body_set);

        let mut integration_parameters = IntegrationParameters::default();
        integration_parameters.dt = 1.0 / 60.0;

        Sim {
            physics_pipeline: PhysicsPipeline::new(),
            integration_parameters,
            island_manager: IslandManager::new(),
            broad_phase: DefaultBroadPhase::new(),
            narrow_phase: NarrowPhase::new(),
            rigid_body_set,
            collider_set,
            impulse_joint_set: ImpulseJointSet::new(),
            multibody_joint_set: MultibodyJointSet::new(),
            ccd_solver: CCDSolver::new(),
            query_pipeline: QueryPipeline::new(),
            drone_handle,
            tick: 0,
            current_action: Action::Hover,
        }
    }

    #[wasm_bindgen(js_name = setAction)]
    pub fn set_action(&mut self, action: JsValue) -> Result<(), JsValue> {
        self.current_action = serde_wasm_bindgen::from_value(action)?;
        Ok(())
    }

    pub fn step(&mut self) {
        let drone = &mut self.rigid_body_set[self.drone_handle];
        let mass = drone.mass();
        let v = *drone.linvel();
        let p = *drone.translation();

        let target = match &self.current_action {
            Action::Velocity { v } => vector![v.x, v.y, v.z],
            Action::Hover => vector![0.0, 0.0, 0.0],
            Action::Land => vector![0.0, -1.0, 0.0],
            Action::Goto { target } => {
                let dx = target.x - p.x;
                let dy = target.y - p.y;
                let dz = target.z - p.z;
                let d = (dx * dx + dy * dy + dz * dz).sqrt();
                if d > 0.01 {
                    let speed = d.min(5.0);
                    vector![dx / d * speed, dy / d * speed, dz / d * speed]
                } else {
                    vector![0.0, 0.0, 0.0]
                }
            }
        };

        const GRAVITY_COMP: f32 = 9.81;
        const VEL_KP: f32 = 8.0;

        let force = vector![
            mass * VEL_KP * (target.x - v.x),
            mass * (VEL_KP * (target.y - v.y) + GRAVITY_COMP),
            mass * VEL_KP * (target.z - v.z)
        ];

        drone.reset_forces(true);
        drone.add_force(force, true);

        let gravity = vector![0.0, -9.81, 0.0];
        let physics_hooks = ();
        let event_handler = ();

        self.physics_pipeline.step(
            &gravity,
            &self.integration_parameters,
            &mut self.island_manager,
            &mut self.broad_phase,
            &mut self.narrow_phase,
            &mut self.rigid_body_set,
            &mut self.collider_set,
            &mut self.impulse_joint_set,
            &mut self.multibody_joint_set,
            &mut self.ccd_solver,
            Some(&mut self.query_pipeline),
            &physics_hooks,
            &event_handler,
        );

        self.tick += 1;
    }

    #[wasm_bindgen(js_name = getObservation)]
    pub fn get_observation(&self) -> Result<JsValue, JsValue> {
        let drone = &self.rigid_body_set[self.drone_handle];
        let p = drone.translation();
        let v = drone.linvel();
        let r = drone.rotation();
        let a = drone.angvel();

        let obs = Observation {
            tick: self.tick,
            position: V3 { x: p.x, y: p.y, z: p.z },
            velocity: V3 { x: v.x, y: v.y, z: v.z },
            orientation: Q4 { x: r.i, y: r.j, z: r.k, w: r.w },
            angular_velocity: V3 { x: a.x, y: a.y, z: a.z },
        };

        serde_wasm_bindgen::to_value(&obs).map_err(Into::into)
    }

    pub fn reset(&mut self) {
        let drone = &mut self.rigid_body_set[self.drone_handle];
        drone.set_translation(vector![0.0, 1.5, 0.0], true);
        drone.set_linvel(vector![0.0, 0.0, 0.0], true);
        drone.set_rotation(Rotation::identity(), true);
        drone.set_angvel(vector![0.0, 0.0, 0.0], true);
        self.tick = 0;
        self.current_action = Action::Hover;
    }
}

impl Default for Sim {
    fn default() -> Self {
        Self::new()
    }
}
