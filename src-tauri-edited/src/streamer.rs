use gst::prelude::*;
use tauri::ipc::{Channel, Response};

#[tauri::command]
pub fn start_stream(on_frame: Channel<Response>) -> Result<(), String> {
    stream(on_frame).map_err(|e| e.to_string())
}

fn stream(on_frame: Channel<Response>) -> Result<(), Box<dyn std::error::Error>> {
    gst::init()?;
    let pipeline = gst::Pipeline::new();

    let src = gst::ElementFactory::make("v4l2src")
        .name("webcam")
        // .property_from_str("pattern", "snow")
        // .property("is-live", true)
        .property("device", "/dev/video0")
        .build()?;

    let conv = gst::ElementFactory::make("videoconvert").build()?;
    let rate = gst::ElementFactory::make("videorate").build()?;

    let caps = gst::Caps::builder("video/x-raw")
        .field("format", "I420")
        .field("width", 640i32)
        .field("height", 480i32)
        .field("framerate", gst::Fraction::new(30, 1))
        .build();

    let queue = gst::ElementFactory::make("queue").build()?;

    let enc = gst::ElementFactory::make("x264enc")
        .property_from_str("tune", "zerolatency")
        .property_from_str("speed-preset", "ultrafast")
        .property("sliced-threads", true)
        .property("bframes", 0u32)
        .property("key-int-max", 1u32)
        .build()?;

    let parse = gst::ElementFactory::make("h264parse").build()?;

    let h264_caps = gst::Caps::builder("video/x-h264")
        .field("stream-format", "avc")
        .field("alignment", "au")
        .field("profile", "constrained-baseline")
        .build();
    let mux = gst::ElementFactory::make("cmafmux")
        .property("fragment-duration", gst::ClockTime::from_mseconds(33))
        .build()?;

    let appsink = gst_app::AppSink::builder().sync(false).build();

    appsink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |sink| {
                let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                let buffer = sample.buffer().ok_or(gst::FlowError::Error)?;
                let map = buffer.map_readable().map_err(|_| gst::FlowError::Error)?;

                let _ = on_frame.send(Response::new(map.as_slice().to_vec()));
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );

    // let sink = gst::ElementFactory::make("waylandsink").build()?;

    pipeline.add_many([
        &src,
        &conv,
        &rate,
        &queue,
        &enc,
        &parse,
        &mux,
        appsink.upcast_ref(),
    ])?;

    gst::Element::link_many([&src, &conv, &rate])?;
    rate.link_filtered(&queue, &caps)?;
    gst::Element::link_many([&queue, &enc, &parse])?;
    parse.link_filtered(&mux, &h264_caps)?;
    mux.link(&appsink)?;

    let _ = pipeline.set_state(gst::State::Playing);

    std::thread::spawn(move || {
        let bus = pipeline.bus().unwrap();
        while let Some(msg) = bus.timed_pop(gst::ClockTime::NONE) {
            use gst::MessageView;
            match msg.view() {
                MessageView::Eos(..) => break,
                MessageView::Error(err) => {
                    eprintln!(
                        "Error from {:?}: {} ({:?})",
                        err.src().map(|s| s.name()),
                        err.error(),
                        err.debug()
                    );
                    break;
                }
                _ => (),
            }
        }
        let _ = pipeline.set_state(gst::State::Null);
    });

    Ok(())
}
