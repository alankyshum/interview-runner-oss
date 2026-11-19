import CourseShell from "./course/CourseShell";
import DesignSystemGallery from "./ui/DesignSystemGallery";

export default function App() {
  return window.location.pathname === '/design-system' ? <DesignSystemGallery /> : <CourseShell />;
}
