import styles from "./page.module.css";
// import ScaleAutoDetect from "./test";
import ScaleAutoDetect2 from "./test2";

export default function Home() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        {/* <ScaleAutoDetect /> */}
        <ScaleAutoDetect2 />
      </main>
    </div>
  );
}
